/**
 * Transport-agnostic DLNA client interface.
 *
 * The renderer talks to DLNA devices through this interface regardless of
 * whether the backend is the Electron main process (IPC) or a standalone
 * casting server (WebSocket). Two implementations exist:
 *
 *   - `ElectronDlnaClient` (dlna-electron-client.ts): wraps window.api.
 *     dlnaPlayer / dlnaPlayerListener. Only available when isElectron().
 *
 *   - `WsDlnaClient` (dlna-ws-client.ts): WebSocket client that speaks the
 *     protocol in src/shared/types/cast-types.ts. Works in any browser-like
 *     environment.
 *
 * The interface is a strict superset of the preload API at
 * src/preload/dlna-player.ts (26 methods + 11 event subscribers) with two
 * differences so transport implementations can adhere to it cleanly:
 *
 *   1. Event subscribers DROP the Electron `IpcRendererEvent` first arg.
 *      Callers receive only the payload. This is the only behavioral change
 *      for the Electron-backed client — `_event` is discarded in the adapter.
 *
 *   2. Each event subscriber returns an `unsubscribe` function instead of
 *      relying on `ipc.removeAllListeners(channel)` in a useEffect cleanup.
 *      This works for both transports (WS has no global IPC bus to clear).
 *
 * `null` (no backend available) is a valid `DlnaClient` value — callers
 * should treat it as "DLNA not supported in this environment".
 */
import type { CastPlayerState, CastQueueSnapshot, CastQueueSong } from '/@/shared/types/cast-types';
import type {
    ConnectPlaybackInfo,
    ConnectResult,
    DlnaDevice,
    DlnaToastPayload,
    GroupMember,
    GroupMemberVolumePayload,
    SpeakerProperties,
    SpeedFileData,
    TrackMetadata,
} from '/@/shared/types/dlna';
import type { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

export interface DlnaClient extends DlnaSessionRpc {
    // Groups
    addGroupMember(device: DlnaDevice): Promise<{ success: boolean }>;

    cancelSpeedFile(data: Omit<SpeedFileData, 'offset'>): void;
    checkSpeedFile(data: Omit<SpeedFileData, 'offset'>): Promise<null | string>;
    clearNextUrl(): void;
    connect(device: DlnaDevice): Promise<ConnectResult>;

    destroySpeedProxy(): void;
    disconnect(): Promise<boolean>;
    disconnectPassive(): Promise<boolean>;
    // Discovery & connection
    discover(): Promise<DlnaDevice[]>;
    /**
     * Return the last-known group state (from `hello` or a
     * `rendererDlnaGroupState` event) without a round-trip.  Returns
     * `null` if no group state has been received yet.  Used by the
     * cast button on mount/swap to paint the blue/connected state
     * immediately.  Only supported by `WsDlnaClient` — Electron IPC
     * client returns `null`.
     */
    getCachedGroupState?(): GroupMember[] | null;
    getGroupState(): Promise<GroupMember[]>;
    getPosition(): Promise<number>;
    // Speaker properties (Sonos)
    getSpeakerProperties(deviceId: string): Promise<null | SpeakerProperties>;

    /** True when this client talks to the server via WS (dlna-session
     *  RPCs are available).  False for the Electron IPC client — the
     *  store uses this to decide whether to forward an action to the
     *  server or fall back to legacy local mutation + `playUrl`. */
    isWsClient: boolean;
    mute(muted: boolean): void;
    // Event subscription. One listener per event name per client (mirrors
    // the `singleOn` semantics in src/preload/dlna-player.ts:49). Calling
    // `on(name, cb)` a second time with the same `name` replaces the prior
    // listener. Returns an unsubscribe function.
    on<E extends DlnaEventName>(event: E, cb: DlnaClientEvents[E]): Unsubscribe;

    pause(): void;
    play(): void;
    // Playback
    playUrl(
        url: string,
        metadata: TrackMetadata,
        opts?: { isMuted?: boolean; seekTo?: number },
    ): void;
    // Speed transcoding
    prepareSpeedFile(data: SpeedFileData): Promise<null | string>;
    removeGroupMember(deviceId: string): Promise<{ success: boolean }>;

    seek(seconds: number): void;
    setGroupMemberMute(deviceId: string, muted: boolean): void;

    setGroupMemberVolume(deviceId: string, volume: number): void;

    setNextUrl(url: string, metadata: TrackMetadata): void;
    // Radio mode
    setRadioMode(enabled: boolean): void;
    setSpeakerProperty(
        deviceId: string,
        property: keyof SpeakerProperties,
        value: boolean | number,
    ): void;
    stop(): void;

    // Volume / mute
    volume(value: number): void;
}

/** All methods on DlnaClientMethods. Types-only import; no runtime effect. */
export interface DlnaClientEvents {
    /** Mirrors `rendererCurrentTime` IPC channel. Payload = playback seconds. */
    rendererCurrentTime: (time: number) => void;
    /**
     * Mirrors `rendererDlnaConnectPlayback` IPC channel. Fired when a
     * device is already playing something and we should sync the queue.
     */
    rendererDlnaConnectPlayback: (info: ConnectPlaybackInfo) => void;
    /** Mirrors `rendererDlnaDiscoveryUpdate` IPC channel. */
    rendererDlnaDiscoveryUpdate: (devices: DlnaDevice[]) => void;
    /** Mirrors `rendererDlnaGroupMemberVolume` IPC channel. */
    rendererDlnaGroupMemberVolume: (payload: GroupMemberVolumePayload) => void;
    /** Mirrors `rendererDlnaGroupState` IPC channel. */
    rendererDlnaGroupState: (state: GroupMember[]) => void;
    /** Mirrors `rendererDlnaPrevTrack` IPC channel. No payload. */
    rendererDlnaPrevTrack: () => void;
    /** Mirrors `rendererDlnaToast` IPC channel. */
    rendererDlnaToast: (payload: DlnaToastPayload) => void;
    /** Mirrors `rendererDlnaTrackEnded` IPC channel. No payload. */
    rendererDlnaTrackEnded: () => void;
    /** Mirrors `rendererDlnaTransportState` IPC channel. */
    rendererDlnaTransportState: (state: string) => void;
    /** Mirrors `rendererDlnaVolume` IPC channel. */
    rendererDlnaVolume: (volume: number) => void;
    /**
     * Partial player-state patch (Phase D). WS-only. Only touched keys
     * should be written to the store; `seekTo: -1` means "no seek".
     */
    rendererPlayerState: (patch: Partial<CastPlayerState>) => void;
    /**
     * Server-authoritative queue snapshot (Phase D). WS-only — the Electron
     * IPC path never emits this. Replaces the entire local queue + player
     * state. Apply with `applyingRemoteUpdate = true` to avoid re-forwarding.
     */
    rendererQueueState: (state: { player: CastPlayerState; queue: CastQueueSnapshot }) => void;
}

export type DlnaEventName = keyof DlnaClientEvents;

/**
 *  Server-authoritative session RPCs (Phase D).  Only present on
 *  WS-backed clients (the Electron IPC path keeps using `playUrl` /
 *  `setNextUrl`).  The renderer invokes these instead of mutating its
 *  local store when `isDlnaMode === true`; the server is the source
 *  of truth for queue + player state.
 *
 *  All methods return `Promise<{ ok: boolean }>` (or a snapshot for
 *  `getQueueState`) — the renderer's local copy of the state arrives
 *  asynchronously via the `rendererQueueState` / `rendererPlayerState`
 *  event channels.
 *
 *  Methods are prefixed with `session` where they would otherwise clash
 *  with the legacy fire-and-forget device commands (`pause`, `play`,
 *  `seek`, `setVolume`, `setMuted`, `setSpeed`, `stop`).  The legacy
 *  commands are still used by the Electron IPC path and by the pre-
 *  `setQueue` DLNA mode (before the renderer has opted into server-
 *  authoritative queue ownership).
 */
export interface DlnaSessionRpc {
    getQueueState: () => Promise<{ player: CastPlayerState; queue: CastQueueSnapshot }>;
    next: (toNextAlbum?: boolean) => Promise<{ ok: boolean }>;
    playByIndex: (index: number) => Promise<{ ok: boolean }>;
    playByUniqueId: (uniqueId: string) => Promise<{ ok: boolean }>;
    previous: (toPreviousAlbum?: boolean) => Promise<{ ok: boolean }>;
    queueAdd: (
        songs: CastQueueSong[],
        playType: Play,
        playSongId?: string,
    ) => Promise<{ ok: boolean }>;
    queueClear: () => Promise<{ ok: boolean }>;
    queueMove: (
        uniqueIds: string[],
        targetUniqueId: string,
        edge: 'bottom' | 'top',
    ) => Promise<{ ok: boolean }>;
    queueRemove: (uniqueIds: string[]) => Promise<{ ok: boolean }>;
    queueShuffle: () => Promise<{ ok: boolean }>;
    sessionPause: () => Promise<{ ok: boolean }>;
    sessionPlay: () => Promise<{ ok: boolean }>;
    sessionSeek: (seconds: number) => Promise<{ ok: boolean }>;
    sessionSetMuted: (muted: boolean) => Promise<{ ok: boolean }>;
    sessionSetRepeat: (repeat: PlayerRepeat) => Promise<{ ok: boolean }>;
    sessionSetShuffle: (shuffle: PlayerShuffle) => Promise<{ ok: boolean }>;
    sessionSetSpeed: (speed: number) => Promise<{ ok: boolean }>;
    sessionSetStatus: (status: PlayerStatus) => Promise<{ ok: boolean }>;
    sessionSetVolume: (volume: number) => Promise<{ ok: boolean }>;
    sessionStop: () => Promise<{ ok: boolean }>;
    setQueue: (
        queue: CastQueueSnapshot,
        playerState?: Partial<CastPlayerState>,
    ) => Promise<{ ok: boolean }>;
}

/** Subscriber returned by `on(...)`. Call to remove the listener. */
export type Unsubscribe = () => void;

/**
 * Type guard distinguishing a working client from a null backend. Provided
 * for callers that prefer an explicit check over optional chaining.
 */
export function isDlnaClient(value: DlnaClient | null): value is DlnaClient {
    return value !== null;
}
