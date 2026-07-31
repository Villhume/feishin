import type {
    CastClientCommand,
    CastClientRpc,
    CastEventName,
    CastHelloMessage,
    CastRpcError,
    CastRpcMethod,
    CastRpcOk,
    CastRpcResult,
    CastServerMessage,
} from '/@/shared/types/cast-types';
/**
 * WebSocket transport for the standalone casting server.
 *
 * Mirrors the WS server pattern in src/main/features/core/remote/index.ts:
 *   - Uses the `ws` library directly.
 *   - Optional bearer-token auth on the HTTP upgrade.
 *   - `hello` message on connect.
 *   - Heartbeat ping every 15s; 3 missed pongs (~45s) → close 4003.
 *   - Discriminated-union JSON protocol (see src/shared/types/cast-types.ts).
 *
 * Routes incoming RPC requests and commands to a `ControllerLike` instance.
 * Forwards controller-emitted events to every connected client.
 */
import type { IncomingMessage } from 'http';
import type { WebSocket, WebSocketServer } from 'ws';

import type { ControllerLike, TransportLogger } from '../dlna/types';

const PROTOCOL_VERSION = '1';

const HEARTBEAT_INTERVAL_MS = 15_000;
/** Number of consecutive missed pongs before a client is considered
 *  dead and disconnected.  At a 15s interval, 3 missed pongs means
 *  the client has been unresponsive for ~45s — long enough to ride
 *  out temporary network hiccups, browser tab throttling, or GC
 *  pauses without a spurious 4003 disconnect. */
const HEARTBEAT_MAX_MISSES = 3;

export interface WsTransportOptions {
    authToken?: string;
    hasFfmpeg: () => boolean;
    logger: TransportLogger;
}

interface ClientState {
    authenticated: boolean;
    isAlive: boolean;
    missedPongs: number;
}

export class WsTransport {
    private clients = new Map<WebSocket, ClientState>();
    private heartbeat: NodeJS.Timeout | null = null;

    constructor(
        private readonly wss: WebSocketServer,
        private readonly controller: ControllerLike,
        private readonly options: WsTransportOptions,
    ) {
        this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
        this.heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
    }

    /** Attach a listener to the controller's event emitter. */
    bindControllerEvents(emitter: {
        on: (event: CastEventName, cb: (data: unknown) => void) => void;
    }): void {
        const events: CastEventName[] = [
            'rendererCurrentTime',
            'rendererDlnaTrackEnded',
            'rendererDlnaConnectPlayback',
            'rendererDlnaTransportState',
            'rendererDlnaPrevTrack',
            'rendererDlnaVolume',
            'rendererDlnaToast',
            'rendererDlnaGroupState',
            'rendererDlnaGroupMemberVolume',
            'rendererDlnaDiscoveryUpdate',
            // ---- Server-authoritative session events (Phase D) ----
            'rendererQueueState',
            'rendererPlayerState',
        ];
        for (const event of events) {
            emitter.on(event, (data) => this.broadcastEvent(event, data));
        }
    }

    /** Emit a controller event to every connected, authenticated client. */
    broadcastEvent<E extends CastEventName>(event: E, data: unknown): void {
        const message: CastServerMessage = { data, event, type: 'event', v: 1 };
        const payload = JSON.stringify(message);
        for (const [client, state] of this.clients.entries()) {
            if (!state.authenticated) continue;
            if (client.readyState === client.OPEN) {
                client.send(payload);
            }
        }
    }

    close(): void {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
        for (const [client] of this.clients) {
            try {
                client.close(4000, 'server shutdown');
            } catch {
                // Ignore
            }
        }
        this.clients.clear();
    }

    private checkHeartbeats(): void {
        for (const [client, state] of this.clients) {
            if (!state.isAlive) {
                state.missedPongs++;
                if (state.missedPongs >= HEARTBEAT_MAX_MISSES) {
                    try {
                        client.close(4003, 'timeout');
                    } catch {
                        // Ignore
                    }
                    this.clients.delete(client);
                    continue;
                }
            } else {
                state.missedPongs = 0;
            }
            state.isAlive = false;
            try {
                client.ping();
            } catch {
                // Ignore
            }
        }
    }

    // -----------------------------------------------------------------------
    // Connection lifecycle
    // -----------------------------------------------------------------------

    private handleConnection(ws: WebSocket, req: IncomingMessage): void {
        const state: ClientState = {
            authenticated: !this.options.authToken,
            isAlive: true,
            missedPongs: 0,
        };
        this.clients.set(ws, state);
        if (this.options.authToken) {
            // Two ways to send the bearer token:
            //   1. `Authorization: Bearer <token>` header (non-browser clients)
            //   2. `?token=<token>` query param (browsers — can't set headers
            //      on a WS upgrade). peeled from req.url.
            const headerAuth = req.headers.authorization;
            const expected = `Bearer ${this.options.authToken}`;
            let ok = headerAuth === expected;
            if (!ok) {
                try {
                    const query = new URL(req.url || '', 'http://localhost').searchParams;
                    ok = query.get('token') === this.options.authToken;
                } catch {
                    ok = false;
                }
            }
            if (!ok) {
                ws.close(4001, 'auth failed');
                this.clients.delete(ws);
                return;
            }
            state.authenticated = true;
        }

        ws.on('pong', () => {
            state.isAlive = true;
        });
        ws.on('message', (raw) => this.handleMessage(ws, state, raw));
        ws.on('close', () => {
            this.clients.delete(ws);
        });
        ws.on('error', (err) => {
            this.options.logger.info('WS client error', err);
            this.clients.delete(ws);
        });

        const hello: CastHelloMessage = {
            connected: this.controller.isConnected(),
            ffmpegPresent: this.options.hasFfmpeg(),
            type: 'hello',
            v: 1,
            version: PROTOCOL_VERSION,
        };

        // If the server already has an active DLNA session, embed a
        // snapshot of the current playback state in the hello message.
        // This lets a newly-connected client (e.g. a second browser tab
        // opening while another is already casting) mirror the session
        // without re-querying the device.  Embedding it in `hello` (rather
        // than as separate events) avoids a race where listeners wouldn't
        // be registered yet when the events arrive.
        if (this.controller.isConnected()) {
            try {
                const snapshot = this.controller.getPlaybackSnapshot();
                if (snapshot.playback) {
                    hello.playback = snapshot.playback;
                }
                hello.volume = snapshot.volume;
                if (snapshot.groupState.length > 0) {
                    hello.groupState = snapshot.groupState;
                }
                // Phase D: when the server is authoritative for queue +
                // player state, embed the full snapshot so the new client
                // can mirror without re-querying the device or the
                // session.  This supersedes the legacy 500ms-delayed
                // event block below.
                if (this.controller.isServerAuthoritative()) {
                    hello.queueState = this.controller.getQueueState();
                }
            } catch (err) {
                this.options.logger.info('Failed to embed playback snapshot in hello', err);
            }
        }
        ws.send(JSON.stringify(hello));

        // If the server already has an active DLNA session, push the current
        // state to this client as real events.  We embed a snapshot in the
        // `hello` message above (for the engine's mount-effect handoff), but
        // the cast button and other UI components rely on event listeners
        // that aren't registered yet when `hello` arrives — they only mount
        // after the PlayerType switch triggered by the `hello` handler.
        //
        // Sending the events after a delay gives the client time to:
        //   1. Process hello (switch PlayerType to DLNA)
        //   2. Mount the DLNA engine + cast button
        //   3. Register event listeners via useEffect
        //
        // At that point the events below are delivered through the normal
        // event channel and picked up by the existing listeners, making the
        // secondary tab's UI reflect the active session (blue cast button,
        // group state, current song, volume).
        //
        // Phase D: skip this block when server-authoritative — the
        // `queueState` snapshot in hello replaces it (the renderer's
        // `dlna-session-sync.ts` hook applies the snapshot via its own
        // listener registration, which happens after PlayerType switch).
        if (this.controller.isConnected() && !this.controller.isServerAuthoritative()) {
            setTimeout(() => {
                if (ws.readyState !== ws.OPEN) return;
                try {
                    const snapshot = this.controller.getPlaybackSnapshot();
                    if (snapshot.groupState.length > 0) {
                        this.sendEventToClient(ws, 'rendererDlnaGroupState', snapshot.groupState);
                    }
                    if (snapshot.playback) {
                        this.sendEventToClient(ws, 'rendererDlnaConnectPlayback', {
                            duration: snapshot.playback.duration,
                            nextUri: snapshot.playback.nextUri,
                            position: snapshot.playback.position,
                            transportState: snapshot.playback.transportState,
                            uri: snapshot.playback.uri,
                        });
                        this.sendEventToClient(
                            ws,
                            'rendererDlnaTransportState',
                            snapshot.playback.transportState,
                        );
                    }
                    this.sendEventToClient(ws, 'rendererDlnaVolume', snapshot.volume);
                } catch (err) {
                    this.options.logger.info('Failed to send state-sync events', err);
                }
            }, 500);
        }
    }

    private async handleMessage(ws: WebSocket, state: ClientState, raw: unknown): Promise<void> {
        if (!state.authenticated) return;
        const rawStr = typeof raw === 'string' ? raw : (raw as Buffer | Uint8Array).toString();
        let message: any;
        try {
            message = JSON.parse(rawStr);
        } catch (err) {
            this.options.logger.info('WS message parse failed', err);
            return;
        }
        if (!message || message.v !== 1) return;

        if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', v: 1 } satisfies CastServerMessage));
            return;
        }

        if (message.type === 'command') {
            this.routeCommand(message as CastClientCommand);
            return;
        }

        // RPC
        await this.routeRpc(ws, message as CastClientRpc);
    }

    // -----------------------------------------------------------------------
    // Message handling
    // -----------------------------------------------------------------------

    private routeCommand(cmd: CastClientCommand): void {
        const c = this.controller;
        try {
            switch (cmd.method) {
                case 'cancelSpeedFile': {
                    const { data } = cmd as Extract<
                        CastClientCommand,
                        { method: 'cancelSpeedFile' }
                    >;
                    c.cancelSpeedFile(data);
                    return;
                }
                case 'clearNextUrl':
                    c.clearNextUrl();
                    return;
                case 'destroySpeedProxy':
                    c.destroySpeedProxy();
                    return;
                case 'mute': {
                    const { muted } = cmd as Extract<CastClientCommand, { method: 'mute' }>;
                    c.mute(muted);
                    return;
                }
                case 'pause':
                    c.pause();
                    return;
                case 'play':
                    c.play();
                    return;
                case 'playUrl': {
                    const { metadata, opts, url } = cmd as Extract<
                        CastClientCommand,
                        { method: 'playUrl' }
                    >;
                    c.playUrl(url, metadata, opts);
                    return;
                }
                case 'seek': {
                    const { seconds } = cmd as Extract<CastClientCommand, { method: 'seek' }>;
                    c.seek(seconds);
                    return;
                }
                case 'setGroupMemberMute': {
                    const { deviceId, muted } = cmd as Extract<
                        CastClientCommand,
                        { method: 'setGroupMemberMute' }
                    >;
                    c.setGroupMemberMute(deviceId, muted);
                    return;
                }
                case 'setGroupMemberVolume': {
                    const { deviceId, volume } = cmd as Extract<
                        CastClientCommand,
                        { method: 'setGroupMemberVolume' }
                    >;
                    c.setGroupMemberVolume(deviceId, volume);
                    return;
                }
                case 'setNextUrl': {
                    const { metadata, url } = cmd as Extract<
                        CastClientCommand,
                        { method: 'setNextUrl' }
                    >;
                    c.setNextUrl(url, metadata);
                    return;
                }
                case 'setRadioMode': {
                    const { enabled } = cmd as Extract<
                        CastClientCommand,
                        { method: 'setRadioMode' }
                    >;
                    c.setRadioMode(enabled);
                    return;
                }
                case 'setSpeakerProperty': {
                    const { deviceId, property, value } = cmd as Extract<
                        CastClientCommand,
                        { method: 'setSpeakerProperty' }
                    >;
                    c.setSpeakerProperty(deviceId, property, value);
                    return;
                }
                case 'stop':
                    c.stop();
                    return;
                case 'volume': {
                    const { value } = cmd as Extract<CastClientCommand, { method: 'volume' }>;
                    c.volume(value);
                    return;
                }
            }
        } catch (err) {
            this.options.logger.info(`Command ${cmd.method} threw`, err);
        }
    }

    private async routeRpc(ws: WebSocket, req: CastClientRpc): Promise<void> {
        const { id, method } = req;
        try {
            let result: unknown;
            switch (method) {
                case 'addGroupMember': {
                    const { device } = req as Extract<CastClientRpc, { method: 'addGroupMember' }>;
                    result = await this.controller.addGroupMember(device);
                    break;
                }
                case 'checkSpeedFile': {
                    const { data } = req as Extract<CastClientRpc, { method: 'checkSpeedFile' }>;
                    result = { url: await this.controller.checkSpeedFile(data) };
                    break;
                }
                case 'connect': {
                    const { device } = req as Extract<CastClientRpc, { method: 'connect' }>;
                    result = await this.controller.connect(device);
                    break;
                }
                case 'disconnect':
                    result = { ok: await this.controller.disconnect() };
                    break;
                case 'disconnectPassive':
                    result = { ok: await this.controller.disconnectPassive() };
                    break;
                case 'discover':
                    result = { devices: await this.controller.discover() };
                    break;
                case 'getGroupState':
                    result = { state: await this.controller.getGroupState() };
                    break;
                case 'getPosition':
                    result = { position: await this.controller.getPosition() };
                    break;
                case 'getQueueState':
                    result = this.controller.getQueueState();
                    break;
                case 'getSpeakerProperties': {
                    const { deviceId } = req as Extract<
                        CastClientRpc,
                        { method: 'getSpeakerProperties' }
                    >;
                    result = { properties: await this.controller.getSpeakerProperties(deviceId) };
                    break;
                }
                case 'next': {
                    const { toNextAlbum } = req as Extract<CastClientRpc, { method: 'next' }>;
                    result = await this.controller.sessionNext(toNextAlbum);
                    break;
                }
                case 'playByIndex': {
                    const { index } = req as Extract<CastClientRpc, { method: 'playByIndex' }>;
                    result = await this.controller.sessionPlayByIndex(index);
                    break;
                }
                case 'playByUniqueId': {
                    const { uniqueId } = req as Extract<
                        CastClientRpc,
                        { method: 'playByUniqueId' }
                    >;
                    result = await this.controller.sessionPlayByUniqueId(uniqueId);
                    break;
                }
                case 'prepareSpeedFile': {
                    const { data } = req as Extract<CastClientRpc, { method: 'prepareSpeedFile' }>;
                    result = { url: await this.controller.prepareSpeedFile(data) };
                    break;
                }
                case 'previous': {
                    const { toPreviousAlbum } = req as Extract<
                        CastClientRpc,
                        { method: 'previous' }
                    >;
                    result = await this.controller.sessionPrevious(toPreviousAlbum);
                    break;
                }
                case 'queueAdd': {
                    const { playSongId, playType, songs } = req as Extract<
                        CastClientRpc,
                        { method: 'queueAdd' }
                    >;
                    result = await this.controller.queueAdd(songs, playType, playSongId);
                    break;
                }
                case 'queueClear':
                    result = await this.controller.queueClear();
                    break;
                case 'queueMove': {
                    const { edge, targetUniqueId, uniqueIds } = req as Extract<
                        CastClientRpc,
                        { method: 'queueMove' }
                    >;
                    result = await this.controller.queueMove(uniqueIds, targetUniqueId, edge);
                    break;
                }
                case 'queueRemove': {
                    const { uniqueIds } = req as Extract<CastClientRpc, { method: 'queueRemove' }>;
                    result = await this.controller.queueRemove(uniqueIds);
                    break;
                }
                case 'queueShuffle':
                    result = await this.controller.queueShuffleAll();
                    break;
                case 'removeGroupMember': {
                    const { deviceId } = req as Extract<
                        CastClientRpc,
                        { method: 'removeGroupMember' }
                    >;
                    result = await this.controller.removeGroupMember(deviceId);
                    break;
                }
                case 'seek': {
                    const { seconds } = req as Extract<CastClientRpc, { method: 'seek' }>;
                    result = await this.controller.sessionSeek(seconds);
                    break;
                }
                case 'setMuted': {
                    const { muted } = req as Extract<CastClientRpc, { method: 'setMuted' }>;
                    result = await this.controller.sessionSetMuted(muted);
                    break;
                }
                case 'setPlayerState': {
                    const { status } = req as Extract<CastClientRpc, { method: 'setPlayerState' }>;
                    result = await this.controller.sessionSetStatus(status);
                    break;
                }
                case 'setQueue': {
                    const { playerState, queue } = req as Extract<
                        CastClientRpc,
                        { method: 'setQueue' }
                    >;
                    result = await this.controller.setQueue(queue, playerState);
                    break;
                }
                case 'setRepeat': {
                    const { repeat } = req as Extract<CastClientRpc, { method: 'setRepeat' }>;
                    result = await this.controller.sessionSetRepeat(repeat);
                    break;
                }
                case 'setShuffle': {
                    const { shuffle } = req as Extract<CastClientRpc, { method: 'setShuffle' }>;
                    result = await this.controller.sessionSetShuffle(shuffle);
                    break;
                }
                case 'setSpeed': {
                    const { speed } = req as Extract<CastClientRpc, { method: 'setSpeed' }>;
                    result = await this.controller.sessionSetSpeed(speed);
                    break;
                }
                case 'setVolume': {
                    const { volume } = req as Extract<CastClientRpc, { method: 'setVolume' }>;
                    result = await this.controller.sessionSetVolume(volume);
                    break;
                }
                default: {
                    const err: CastRpcError = {
                        error: { message: `unknown method: ${(req as CastClientRpc).method}` },
                        id,
                        ok: false,
                        type: 'result',
                        v: 1,
                    };
                    ws.send(JSON.stringify(err));
                    return;
                }
            }
            const ok: CastRpcOk<CastRpcMethod> = {
                id,
                method,
                ok: true,
                result: result as CastRpcResult<CastRpcMethod>,
                type: 'result',
                v: 1,
            };
            ws.send(JSON.stringify(ok));
        } catch (err: any) {
            const error: CastRpcError = {
                error: { code: err?.code, message: err?.message ?? String(err) },
                id,
                ok: false,
                type: 'result',
                v: 1,
            };
            ws.send(JSON.stringify(error));
        }
    }

    /** Send an event to a single client (not broadcast).  Used during the
     *  initial state-sync handshake: when a new WS client connects while
     *  the server already has an active DLNA session, we need to push the
     *  current state (group, playback, volume) to that client so it can
     *  mirror the session.  Broadcasting would re-send the state to every
     *  already-connected client, which is redundant (they already have it).
     */
    private sendEventToClient<E extends CastEventName>(
        ws: WebSocket,
        event: E,
        data: unknown,
    ): void {
        if (ws.readyState !== ws.OPEN) return;
        const message: CastServerMessage = { data, event, type: 'event', v: 1 };
        ws.send(JSON.stringify(message));
    }
}
