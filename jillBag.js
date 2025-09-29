/**
 * JillBag: ultra-light host/player wrapper around PeerJS DataConnections
 * =============================================================================
 * PURPOSE
 *  - Provide a tiny, opinionated transport layer for turn-based, host-authoritative
 *    web games using PeerJS.
 *  - The Host owns the authoritative game state. Players send "intents" to the Host,
 *    Host validates/updates, then notifies players.
 *
 * HOW TO IMPORT (serve with correct MIME type!)
 *  - Import this module directly (served as ES module):
 *      import { JillBagHost, JillBagPlayer } from 'https://elan-r.github.io/JillBag/jillBag.js';
 *
 * QUICK START
 *  - Host page:
 *      const host = new JillBagHost(); // creates a new room with hostId (6 letters)
 *      // Display host.hostId (room code) to players
 *      // Subclass and override handleOpen/handleData/handleClose to run your game logic
 *
 *  - Player page:
 *      const player = new JillBagPlayer('<ROOMCODE>'); // connect to an existing host
 *      // Override handleData to render state; call player.sendHost({ type:'move', ... })
 *
 * BEST PRACTICES
 *  - Keep messages as small JSON objects: { type: '...', payload: {...} }.
 *  - Host validates everything (turn order, move legality). Never trust clients.
 *  - Disable player UI when it's not their turn to avoid spurious "move" attempts.
 *  - Treat "connected to signaling" (Peer 'open') and "connected to host" (DataConnection 'open')
 *    as two different states in the UI.
 *
 * EXTENDING
 *  - Subclass JillBagHost and override the "handle*" methods:
 *      handlePeerReady(myId) — signaling server connected; host.myId is available
 *      handlePeerError(err) — signaling/peer errors
 *      handleOpen(otherId) — data channel connected (host: playerId; player: host)
 *      handleData(otherId, data) — incoming messages (JSON recommended)
 *      handleClose(otherId) — data channel closed
 *      handleError(otherId, err) — data channel errors
 *  - Subclass JillBagPlayer and override the "handle*" methods:
 *      handlePeerReady(myId) — signaling server connected; host.myId is available
 *      handlePeerError(err) — signaling/peer errors
 *      handleOpen() — data channel connected (host: playerId; player: host)
 *      handleData(data) — incoming messages (JSON recommended)
 *      handleClose() — data channel closed
 *      handleError(err) — data channel errors
 *
 * MESSAGE CONTRACT (suggestion)
 *  - Player → Host: { type: 'action', action: 'move', payload: {...} }
 *  - Host → Players:
 *      start: { type:'start', you:<playerId>, players:[...], state:{...}, turn:<playerId> }
 *      state: { type:'state', state:{...}, turn:<playerId>, winner?:{...}|null }
 *      end: { type:'end', reason:'host-ended'|'player-left'|'game-over' }
 *      reject: { type:'reject', reason:'room-full' }
 */

import { Peer } from 'https://esm.sh/peerjs@1.5.5?bundle-deps'

/**
 * Generate an uppercase room/player code.
 * @param {number} len - number of characters to generate
 * @param {string} [alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ']
 * @returns {string}
 */
function randomString(len, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    let result = '';

    for (let i = 0; i < len; i++) {
        result += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return result;
}

/**
 * Host-side transport wrapper (authoritative server in the browser).
 * ------------------------------------------------------------------
 * Responsibilities:
 *  - Creates a peer ID (prefix "JillBagHost") and accepts incoming DataConnections.
 *  - Indexes connections by the *logical* playerId provided in connection metadata.
 *  - Provides send/close helpers and lifecycle hooks for subclasses/games.
 *
 * Usage pattern (typical):
 *  class MyGameHost extends JillBagHost {
 *    handleOpen(playerId) { ...seat player, maybe start when enough players... }
 *    handleData(playerId, msg) { ...validate & update state, then notify players... }
 *  }
 *  const host = new MyGameHost();  // display host.hostId as the join code
 */
export class JillBagHost {

    /** Build the public peer id for a host code. */
    static _hostPeerId(hostId) {
        return `JillBagHost${hostId}`;
    }

    /**
     * Construct a new host.
     */
    constructor() {
        /** @type {string} 6-letter room/host code players must enter */
        this.hostId = randomString(6);

        /** @type {import('peerjs').Peer} */
        this._peer = new Peer(JillBagHost._hostPeerId(this.hostId));

        /** @type {Map<string, import('peerjs').DataConnection>} logicalId -> DataConnection */
        this._others = new Map();

        // --- Signaling events (PeerJS)
        this._peer.on('open', myId => this.handlePeerReady(myId));
        this._peer.on('error', err => this.handlePeerError(err));
        this._peer.on('disconnected', () => this._peer.reconnect());

        // --- Data connection lifecycle (per remote player)
        this._peer.on('connection', conn => {
            conn.on('open', () => {
                // EXPECTATION: player passes { metadata: { id: <logical playerId> } } in connect()
                const otherId = conn.metadata.id;

                // De-duplicate: close older connection if same logical player reconnects
                if (this._others.has(otherId)) this.close(otherId);

                // Track by logical playerId
                this._others.set(otherId, conn);

                // Route inbound messages to your game logic
                conn.on('data', data => this.handleData(otherId, data));

                // Cleanup on close
                conn.on('close', () => {
                    this._others.delete(otherId);
                    this.handleClose(otherId);
                });

                // Connection-level errors (different from Peer-level errors)
                conn.on('error', err => this.handleError(otherId, err));

                // Notify game code that a player is ready
                this.handleOpen(otherId);
            });
        });
    }

    /**
     * Send a message to a specific player by logical id.
     * @param {string} otherId
     * @param {any} data - JSON-serializable object recommended
     * @returns {boolean} true if queued for send, false if not connected
     */
    send(otherId, data) {
        const conn = this._others.get(otherId);

        if (!conn || !conn.open) {
            console.warn(`No open connection to ${otherId}`);
            return false;
        }

        conn.send(data);
        return true;
    }

    /**
     * Close a specific player's data connection and remove from the map.
     * Safe to call even if the connection is already closed.
     */
    close(otherId) {
        const conn = this._others.get(otherId);

        if (conn) try { conn.close(); } catch {}

        this._others.delete(otherId);
    }

    /** Close all player connections (does not destroy the Peer). */
    closeAll() {
        for (const [, conn] of this._others) {
            try { conn.close(); } catch {}
        }

        this._others.clear();
    }

    // ------------------------ Overridable Hooks ------------------------
    /** Peer (signaling) is ready; show `this.hostId` to users. */
    handlePeerReady(myId) { console.log(`Peer open with id ${myId}.`) };

    /** Peer-level error (e.g., signaling trouble). */
    handlePeerError(err) { console.error(`Peer error: ${err}.`) };

    /** A player data channel opened. */
    handleOpen(otherId) { console.log(`Connection with ${otherId} open.`); }

    /** Message from a player (override in your game to process intents). */
    handleData(otherId, data) { console.log('Received from', otherId, 'data', data); }

    /** Player data channel closed (remove from lobby/seats, end game, etc.). */
    handleClose(otherId) { console.log(`Connection with ${otherId} closed.`); }

    /** Data channel error with a specific player. */
    handleError(otherId, err) { console.error(`Received from ${otherId} error ${err}.`); }

}

/**
 * Player-side transport wrapper.
 * --------------------------------
 * Responsibilities:
 *  - Creates a unique player peer id (prefix "JillBagPlayer").
 *  - Connects to the host peer id derived from the host's 6-letter code.
 *  - Provides sendHost helper and lifecycle hooks.
 *
 * Usage pattern (typical):
 *  class MyGamePlayer extends JillBagPlayer {
 *    handleData(msg) { ...render state, enable/disable actions... }
 *  }
 *  const player = new MyGamePlayer('<ROOMCODE>');
 */
export class JillBagPlayer {

    /** Build the public peer id for a player. */
    static _playerPeerId(playerId) {
        return `JillBagPlayer${playerId}`
    }

    /**
     * @param {string} hostId - 6-letter room code shown on the host page.
     */
    constructor(hostId) {
        /** @type {string} Host's 6-letter room code */
        this.hostId = hostId;

        /** @type {string} Random logical player identifier (10 letters) */
        this._playerId = randomString(10);

        /** @type {import('peerjs').Peer} */
        this._peer = new Peer(JillBagPlayer._playerPeerId(this._playerId));

        /** @type {import('peerjs').DataConnection|null} */
        this._conn = null;

        // --- Signaling ready → attempt data connection to host
        this._peer.on('open', myId => {
            if (!this._conn || !this._conn.open) this._connectToHost();

            this.handlePeerReady(myId);
        });

        this._peer.on('error', err => this.handlePeerError(err));
        this._peer.on('disconnected', () => this._peer.reconnect());
    }

    /**
     * Establish a DataConnection to the host.
     * Sends our logical playerId in metadata so host can index us cleanly.
     * Uses JSON serialization so you can send objects without manual stringify.
     */
    _connectToHost() {
        this._conn = this._peer.connect(
            JillBagHost._hostPeerId(this.hostId),
            {
                metadata: { id: this._playerId },
                serialization: 'json'
            }
        );

        this._conn.on('open', () => {
            // Forward inbound messages to game UI logic
            this._conn.on('data', data => this.handleData(data));

            this._conn.on('close', () => {
                this._conn = null;
                this.handleClose();
            });

            this._conn.on('error', err => this.handleError(err));

            this.handleOpen();
        });
    }

    /**
     * Send a message to the host.
     * @param {any} data - JSON-serializable object recommended
     * @returns {boolean} true if queued, false if not connected
     */
    sendHost(data) {
        if (!this._conn || !this._conn.open) {
            console.warn('No open connection to host.');
            return false;
        }

        this._conn.send(data);
        return true;
    }

    /** Close the data channel to the host (does not destroy the Peer). */
    closeHost() {
        if (this._conn) {
            try { this._conn.close(); } catch {}
        }

        this._conn = null;
    }

    // ------------------------ Overridable Hooks ------------------------
    /** Peer (signaling) is ready; safe to show "Connecting to host…" UI. */
    handlePeerReady(myId) { console.log(`Peer open with id ${myId}.`); };

    /** Peer-level error (e.g., signaling trouble). */
    handlePeerError(err) { console.error(`Peer error: ${err}.`); };

    /** Data channel to host opened (enable UI when your turn). */
    handleOpen() { console.log(`Connection with host open.`); }

    /** Message from host (render state; enable actions if it's your turn). */
    handleData(data) { console.log('Received from host data', data); }

    /** Data channel to host closed (show reconnect UI; disable actions). */
    handleClose() { console.log(`Connection with host closed.`); }

    /** Data channel error (show retry message, maybe backoff). */
    handleError(err) { console.error(`Received from host error ${err}.`); }

}
