/**
 * WebSocket-backed DlnaClient implementation. Speakes the protocol defined
 * in src/shared/types/cast-types.ts.
 *
 * Lifecycle:
 *   - `connect()` opens the WS, waits for `hello`, optionally sends auth.
 *   - `disconnect()` closes the socket cleanly.
 *   - While connected, RPC requests are correlated by `id` and awaited.
 *   - Commands are fire-and-forget.
 *   - Events are pushed from the server and routed to the per-event listener.
 *   - Heartbeat: client sends `ping` every 10s; server replies `pong`. The
 *     server also sends its own WS-layer ping (handled by the `ws` library
 *     on the Node side). On unresponsive pong for HEARTBEAT_TIMEOUT_MS,
 *     we close and notify via `onClose`.
 *
 * Reconnection / reliability is handled by the caller (dlna-client-provider),
 * not by this client. If the socket closes unexpectedly, this client emits
 * the `close` callback and becomes unusable — a new client must be built.
 */
import type {
    CastClientCommand,
    CastClientMessage,
    CastClientRpc,
    CastEvent,
    CastHelloMessage,
    CastRpcError,
    CastRpcMethod,
    CastRpcOk,
    CastRpcResult,
    CastServerMessage,
} from '/@/shared/types/cast-types';
import type { GroupMember } from '/@/shared/types/dlna';

import type { DlnaClient, DlnaClientEvents, DlnaEventName, Unsubscribe } from './dlna-client';

import { PlayerStatus } from '/@/shared/types/types';

const PROTOCOL_VERSION = '1';
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 25_000;
const RPC_TIMEOUT_MS = 30_000;

export interface WsDlnaClientCallbacks {
    /**
     * Called when the socket closes. The client is unusable after this; the
     * caller should render a new one (with exponential backoff retry).
     */
    onClose?: (code: number, reason: string) => void;
    /** Called for unexpected transport errors (parse failures, etc.). */
    onError?: (err: unknown) => void;
    /** Called once `hello` is received. Server may or may not be connected to a device. */
    onHello?: (hello: CastHelloMessage) => void;
}

export interface WsDlnaClientOptions {
    /** Bearer token; if set, sent as `Authorization: Bearer <token>` on upgrade. */
    authToken?: string;
    /** `ws://host:port` or `wss://host:port`. No trailing slash. */
    url: string;
    /** Subprotocol identifier (optional; for future negotiation). */
}

type EventListener = (data: unknown) => void;

interface PendingRpc {
    method: CastRpcMethod;
    reject: (err: Error) => void;
    resolve: (value: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class WsDlnaClient implements DlnaClient {
    /** WS transport supports server-authoritative session RPCs. */
    readonly isWsClient = true;
    /**
     * Cache of the group state from the most recent `hello` (or
     * `rendererDlnaGroupState` event).  The cast button's `useEffect`
     * reads this on mount/swap so it can paint the blue/connected
     * state immediately, without waiting for the next server-pushed
     * group state event.  This closes the timing gap where
     * `emitLocal('rendererDlnaGroupState', ...)` fires before the
     * cast button's listener is re-registered (React fires the
     * `useEffect` after the `setState({ client, clientKey })` commit).
     */
    private cachedGroupState: GroupMember[] | null = null;
    private closed = false;
    private heartbeatTimer: null | ReturnType<typeof setInterval> = null;
    private helloReceived = false;
    private lastPongAt = Date.now();
    private readonly listeners = new Map<DlnaEventName, Set<EventListener>>();
    private readonly pending = new Map<string, PendingRpc>();

    private readonly socket: WebSocket;

    constructor(
        opts: WsDlnaClientOptions,
        private readonly callbacks: WsDlnaClientCallbacks = {},
    ) {
        // Browsers cannot set custom headers on the WS upgrade. We pass the
        // bearer token as `?token=<>` query param. The server's HTTP upgrade
        // handler peels it off and validates against the configured
        // AUTH_TOKEN. The server also accepts `Authorization: Bearer <>`
        // for non-browser clients — both are fine.
        const url = new URL(opts.url);
        if (opts.authToken) {
            url.searchParams.set('token', opts.authToken);
        }
        this.socket = new WebSocket(url.toString());
        this.socket.binaryType = 'arraybuffer';
        this.socket.addEventListener('open', () => this.handleOpen());
        this.socket.addEventListener('message', (e) => this.handleMessage(e));
        this.socket.addEventListener('close', (e) => this.handleClose(e));
        this.socket.addEventListener('error', (e) => this.callbacks.onError?.(e));
    }

    // -------------------------------------------------------------------------
    // DlnaClient surface
    // -------------------------------------------------------------------------

    addGroupMember = (device) => this.rpc('addGroupMember', { device });
    cancelSpeedFile: DlnaClient['cancelSpeedFile'] = (data) =>
        this.command({ data, method: 'cancelSpeedFile' });
    checkSpeedFile = (data) => this.rpc('checkSpeedFile', { data }).then((r) => r.url);
    clearNextUrl: DlnaClient['clearNextUrl'] = () => this.command({ method: 'clearNextUrl' });
    /**
     * Forcibly close the socket from the client side. Rejects all pending
     * RPCs with an error. Safe to call multiple times.
     */
    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('client closed'));
            this.pending.delete(id);
        }
        this.listeners.clear();
        try {
            // 1000 = normal closure
            this.socket.close(1000, 'client close');
        } catch {
            // Ignore
        }
    }
    connect = (device) => this.rpc('connect', { device });
    destroySpeedProxy: DlnaClient['destroySpeedProxy'] = () =>
        this.command({ method: 'destroySpeedProxy' });
    disconnect = () => this.rpc('disconnect', {}).then((r) => r.ok);
    disconnectPassive = () => this.rpc('disconnectPassive', {}).then((r) => r.ok);
    discover = () => this.rpc('discover', {}).then((r) => r.devices);
    /**
     * Emit a synthetic event to the local listeners **without** going through
     * the server. Used by the provider to inject state snapshots (e.g. group
     * state, connect-playback info) that were received in the `hello`
     * handshake message — the server already has the data, so re-broadcasting
     * would be redundant. Without this, the hello snapshot would be silently
     * dropped because the provider has no cast-button state of its own; only
     * the `on(...)` subscribers (engine, cast button) can act on it.
     *
     * `groupState` events are also cached so the cast button's `useEffect`
     * (which re-subscribes on `clientKey` change) can read the latest state
     * immediately via `getCachedGroupState()` — closing the timing gap where
     * this emit fires before the new listener is registered.
     */
    emitLocal<E extends DlnaEventName>(event: E, data: Parameters<DlnaClientEvents[E]>[0]): void {
        if (event === 'rendererDlnaGroupState') {
            this.cachedGroupState = data as GroupMember[];
        }
        const set = this.listeners.get(event);
        if (set) {
            for (const listener of set) {
                listener(data);
            }
        }
    }

    /**
     * Return the last-known group state (from `hello` or a
     * `rendererDlnaGroupState` event).  Returns `null` if no group state
     * has been received yet.  The cast button calls this on mount/swap to
     * paint the blue/connected state immediately.
     */
    getCachedGroupState(): GroupMember[] | null {
        return this.cachedGroupState;
    }
    getGroupState = () => this.rpc('getGroupState', {}).then((r) => r.state);
    getPosition = () => this.rpc('getPosition', {}).then((r) => r.position);
    getQueueState = () => this.rpc('getQueueState', {});
    getSpeakerProperties = (deviceId) =>
        this.rpc('getSpeakerProperties', { deviceId }).then((r) => r.properties);
    /** True if `hello` was received and the socket is still open. */
    isConnected(): boolean {
        return this.helloReceived && this.socket.readyState === this.socket.OPEN;
    }
    mute: DlnaClient['mute'] = (muted) => this.command({ method: 'mute', muted });
    next = (toNextAlbum?: boolean) => this.rpc('next', { toNextAlbum });
    on = <E extends DlnaEventName>(event: E, cb: DlnaClientEvents[E]): Unsubscribe => {
        const listener = cb as EventListener;
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return () => {
            const existing = this.listeners.get(event);
            if (existing) {
                existing.delete(listener);
                if (existing.size === 0) {
                    this.listeners.delete(event);
                }
            }
        };
    };
    pause: DlnaClient['pause'] = () => this.command({ method: 'pause' });
    play: DlnaClient['play'] = () => this.command({ method: 'play' });
    playByIndex = (index: number) => this.rpc('playByIndex', { index });
    playByUniqueId = (uniqueId: string) => this.rpc('playByUniqueId', { uniqueId });
    playUrl: DlnaClient['playUrl'] = (url, metadata, opts) =>
        this.command({ metadata, method: 'playUrl', opts, url });
    prepareSpeedFile = (data) => this.rpc('prepareSpeedFile', { data }).then((r) => r.url);
    previous = (toPreviousAlbum?: boolean) => this.rpc('previous', { toPreviousAlbum });
    queueAdd = (songs, playType, playSongId) =>
        this.rpc('queueAdd', { playSongId, playType, songs });
    queueClear = () => this.rpc('queueClear', {});
    queueMove = (uniqueIds, targetUniqueId, edge) =>
        this.rpc('queueMove', { edge, targetUniqueId, uniqueIds });
    queueRemove = (uniqueIds) => this.rpc('queueRemove', { uniqueIds });
    queueShuffle = () => this.rpc('queueShuffle', {});
    removeGroupMember = (deviceId) => this.rpc('removeGroupMember', { deviceId });
    seek: DlnaClient['seek'] = (seconds) => this.command({ method: 'seek', seconds });
    sessionPause = () => this.rpc('setPlayerState', { status: PlayerStatus.PAUSED });
    sessionPlay = () => this.rpc('setPlayerState', { status: PlayerStatus.PLAYING });
    sessionSeek = (seconds: number) => this.rpc('seek', { seconds });
    sessionSetMuted = (muted: boolean) => this.rpc('setMuted', { muted });
    sessionSetRepeat = (repeat) => this.rpc('setRepeat', { repeat });
    sessionSetShuffle = (shuffle) => this.rpc('setShuffle', { shuffle });
    sessionSetSpeed = (speed: number) => this.rpc('setSpeed', { speed });
    sessionSetStatus = (status) => this.rpc('setPlayerState', { status });
    sessionSetVolume = (volume: number) => this.rpc('setVolume', { volume });
    sessionStop = () => this.rpc('setPlayerState', { status: PlayerStatus.STOPPED });
    setGroupMemberMute: DlnaClient['setGroupMemberMute'] = (deviceId, muted) =>
        this.command({ deviceId, method: 'setGroupMemberMute', muted });
    setGroupMemberVolume: DlnaClient['setGroupMemberVolume'] = (deviceId, vol) =>
        this.command({ deviceId, method: 'setGroupMemberVolume', volume: vol });
    setNextUrl: DlnaClient['setNextUrl'] = (url, metadata) =>
        this.command({ metadata, method: 'setNextUrl', url });

    setQueue = (queue, playerState) => this.rpc('setQueue', { playerState, queue });

    setRadioMode: DlnaClient['setRadioMode'] = (enabled) =>
        this.command({ enabled, method: 'setRadioMode' });

    setSpeakerProperty: DlnaClient['setSpeakerProperty'] = (deviceId, property, value) =>
        this.command({ deviceId, method: 'setSpeakerProperty', property, value });

    // -------------------------------------------------------------------------
    // Transport plumbing
    // -------------------------------------------------------------------------

    stop: DlnaClient['stop'] = () => this.command({ method: 'stop' });

    volume: DlnaClient['volume'] = (value) => this.command({ method: 'volume', value });

    private command(cmd: Omit<CastClientCommand, 'type' | 'v'>): void {
        // Fire-and-forget — no RPC correlation, no ack expected.
        this.send({ ...cmd, type: 'command', v: 1 } as CastClientCommand);
    }

    private handleClose(event: CloseEvent): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`socket closed (${event.code})`));
            this.pending.delete(id);
        }
        this.listeners.clear();
        this.closed = true;
        this.callbacks.onClose?.(event.code, event.reason);
    }

    private handleEvent(ev: CastEvent): void {
        // Cache group state from real server broadcasts so the cast
        // button's `useEffect` (which re-subscribes on `clientKey`
        // change) can read it immediately via `getCachedGroupState()`
        // without waiting for the next push.
        if (ev.event === 'rendererDlnaGroupState') {
            this.cachedGroupState = ev.data as GroupMember[];
        }
        const set = this.listeners.get(ev.event as DlnaEventName);
        if (!set) return;
        for (const listener of set) {
            listener(ev.data);
        }
    }

    private handleHello(hello: CastHelloMessage): void {
        this.helloReceived = true;
        this.lastPongAt = Date.now();
        if (hello.version !== PROTOCOL_VERSION) {
            this.callbacks.onError?.(
                new Error(`protocol version mismatch: ${hello.version} vs ${PROTOCOL_VERSION}`),
            );
        }
        this.callbacks.onHello?.(hello);
    }

    private handleMessage(event: MessageEvent): void {
        let message: CastServerMessage;
        try {
            const text =
                typeof event.data === 'string'
                    ? event.data
                    : new TextDecoder().decode(event.data as ArrayBuffer);
            message = JSON.parse(text) as CastServerMessage;
        } catch (err) {
            this.callbacks.onError?.(err);
            return;
        }
        if (!message || message.v !== 1) return;

        switch (message.type) {
            case 'event':
                this.handleEvent(message);
                break;
            case 'hello':
                this.handleHello(message);
                break;
            case 'pong':
                this.lastPongAt = Date.now();
                break;
            case 'result':
                this.handleResult(message);
                break;
            default:
                // Unknown server message — ignore.
                break;
        }
    }

    private handleOpen(): void {
        // Start heartbeat. We send ping messages and expect pong replies.
        // The server also does its own ping/pong at the WS layer, but
        // application-level ping/pong survives intermediaries that don't
        // forward control frames.
        this.heartbeatTimer = setInterval(() => {
            if (this.closed) return;
            if (Date.now() - this.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
                this.callbacks.onError?.(new Error('heartbeat timeout'));
                try {
                    this.socket.close(4003, 'heartbeat timeout');
                } catch {
                    // Ignore
                }
                return;
            }
            this.send({ type: 'ping', v: 1 });
        }, HEARTBEAT_INTERVAL_MS);
    }

    private handleResult(result: CastRpcError | CastRpcOk<CastRpcMethod>): void {
        const pending = this.pending.get(result.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(result.id);
        if (result.ok) {
            pending.resolve(result.result);
        } else {
            pending.reject(new Error(result.error.message));
        }
    }

    private async rpc<M extends CastRpcMethod>(
        method: M,
        params: Omit<CastClientRpc & { method: M }, 'id' | 'method' | 'v'>,
    ): Promise<CastRpcResult<M>> {
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const request = { id, method, v: 1, ...params } as CastClientRpc;
        return new Promise<CastRpcResult<M>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, RPC_TIMEOUT_MS);
            this.pending.set(id, {
                method,
                reject,
                resolve: resolve as (v: unknown) => void,
                timer,
            });
            try {
                this.send(request);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err as Error);
            }
        });
    }

    private send(message: CastClientMessage): void {
        if (this.closed || this.socket.readyState !== this.socket.OPEN) {
            this.callbacks.onError?.(new Error('socket not open'));
            return;
        }
        this.socket.send(JSON.stringify(message));
    }
}
