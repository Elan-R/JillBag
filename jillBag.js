import { Peer } from 'https://esm.sh/peerjs@1.5.5?bundle-deps'


function randomString(len, alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    let result = '';

    for (let i = 0; i < len; i++) {
        result += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return result;
}


export class JillBagHost {

    static _hostPeerId(hostId) {
        return `JillBagHost${hostId}`;
    }

    constructor() {
        this.hostId = randomString(6);
        this._peer = new Peer(JillBagHost._hostPeerId(this.hostId));
        this._others = new Map();

        this._peer.on('open', myId => this.handlePeerReady(myId));
        this._peer.on('error', err => this.handlePeerError(err));
        this._peer.on('disconnected', () => this._peer.reconnect());

        this._peer.on('connection', conn => {
            conn.on('open', () => {
                const otherId = conn.metadata.id;

                if (this._others.has(otherId)) this.close(otherId);

                this._others.set(otherId, conn);

                conn.on('data', data => this.handleData(otherId, data));
                conn.on('close', () => {
                    this._others.delete(otherId);
                    this.handleClose(otherId);
                });
                conn.on('error', err => this.handleError(otherId, err));

                this.handleOpen(otherId);
            });
        });
    }

    send(otherId, data) {
        const conn = this._others.get(otherId);

        if (!conn || !conn.open) {
            console.warn(`No open connection to ${otherId}`);
            return false;
        }

        conn.send(data);
        return true;
    }

    close(otherId) {
        const conn = this._others.get(otherId);

        if (conn) try { conn.close(); } catch {}

        this._others.delete(otherId);
    }

    closeAll() {
        for (const [, conn] of this._others) {
            try { conn.close(); } catch {}
        }

        this._others.clear();
    }

    handlePeerReady(myId) { console.log(`Peer open with id ${myId}.`) };
    handlePeerError(err) { console.error(`Peer error: ${err}.`) };

    handleOpen(otherId) { console.log(`Connection with ${otherId} open.`); }
    handleData(otherId, data) { console.log('Received from', otherId, 'data', data); }
    handleClose(otherId) { console.log(`Connection with ${otherId} closed.`); }
    handleError(otherId, err) { console.error(`Received from ${otherId} error ${err}.`); }

}


export class JillBagPlayer {

    static _playerPeerId(playerId) {
        return `JillBagPlayer${playerId}`
    }

    constructor(hostId) {
        this.hostId = hostId;
        this._playerId = randomString(10);
        this._peer = new Peer(JillBagPlayer._playerPeerId(this._playerId));
        this._conn = null;

        this._peer.on('open', myId => {
            if (!this._conn || !this._conn.open) this._connectToHost();

            this.handlePeerReady(myId);
        });
        this._peer.on('error', err => this.handlePeerError(err));
        this._peer.on('disconnected', () => this._peer.reconnect());
    }

    _connectToHost() {
        this._conn = this._peer.connect(
            JillBagHost._hostPeerId(this.hostId),
            {
                metadata: { id: this._playerId },
                serialization: 'json'
            }
        );

        this._conn.on('open', () => {
            this._conn.on('data', data => this.handleData(data));
            this._conn.on('close', () => {
                this._conn = null;
                this.handleClose();
            });
            this._conn.on('error', err => this.handleError(err));

            this.handleOpen();
        });
    }

    sendHost(data) {
        if (!this._conn || !this._conn.open) {
            console.warn('No open connection to host.');
            return false;
        }

        this._conn.send(data);
        return true;
    }

    closeHost() {
        if (this._conn) {
            try { this._conn.close(); } catch {}
        }

        this._conn = null;
    }

    handlePeerReady(myId) { console.log(`Peer open with id ${myId}.`); };
    handlePeerError(err) { console.error(`Peer error: ${err}.`); };

    handleOpen() { console.log(`Connection with host open.`); }
    handleData(data) { console.log('Received from host data', data); }
    handleClose() { console.log(`Connection with host closed.`); }
    handleError(err) { console.error(`Received from host error ${err}.`); }

}
