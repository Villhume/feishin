/**
 * WebSocket protocol for the standalone DLNA casting server.
 *
 * Mirrors the discriminator-union pattern used by remote-types.ts.
 * Every message is a JSON object. All messages carry `v: 1` for future
 * versioning.
 *
 * The protocol is split into two client-to-server shapes:
 *   - RPC requests: expects a matching `result` response (correlated by `id`).
 *   - Commands: fire-and-forget state changes (no response).
 *
 * Server-to-client messages are one of:
 *   - `result`: a response to a prior RPC request (ok or error).
 *   - `hello`: sent immediately after WS upgrade succeeds.
 *   - `pong`: response to a client `ping`.
 *   - `event`: a pushed state update (mirrors the 11 `dlnaPlayerListener`
 *     channels in src/preload/dlna-player.ts).
 */
import type {
    ConnectPlaybackInfo,
    DlnaDevice,
    DlnaToastPayload,
    GroupMember,
    GroupMemberVolumePayload,
    SpeakerProperties,
    SpeedFileData,
} from '/@/shared/types/dlna';
import type { QueueSong } from '/@/shared/types/domain-types';
import type { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export type CastRpcMethod =
    | 'discover'
    | 'connect'
    | 'disconnect'
    | 'disconnectPassive'
    | 'getPosition'
    | 'getGroupState'
    | 'addGroupMember'
    | 'removeGroupMember'
    | 'getSpeakerProperties'
    | 'prepareSpeedFile'
    | 'checkSpeedFile'
    // ---- Server-authoritative session RPCs (Phase C-E) ----
    | 'setQueue'
    | 'queueAdd'
    | 'queueClear'
    | 'queueMove'
    | 'queueRemove'
    | 'queueShuffle'
    | 'setPlayerState'
    | 'setRepeat'
    | 'setShuffle'
    | 'setSpeed'
    | 'next'
    | 'previous'
    | 'playByIndex'
    | 'playByUniqueId'
    | 'seek'
    | 'setVolume'
    | 'setMuted'
    | 'getQueueState';

export interface CastRpcRequest {
    v: 1;
    id: string;
    method: CastRpcMethod;
    // discriminated by `method` — narrowed via CastRpcRequestOf below
    [k: string]: unknown;
}

export interface CastRpcRequestOf<M extends CastRpcMethod> {
    v: 1;
    id: string;
    method: M;
}

export interface CastDiscoverRequest extends CastRpcRequestOf<'discover'> {}
export interface CastConnectRequest extends CastRpcRequestOf<'connect'> {
    device: DlnaDevice;
}
export interface CastDisconnectRequest extends CastRpcRequestOf<'disconnect'> {}
export interface CastDisconnectPassiveRequest
    extends CastRpcRequestOf<'disconnectPassive'> {}
export interface CastGetPositionRequest extends CastRpcRequestOf<'getPosition'> {}
export interface CastGetGroupStateRequest extends CastRpcRequestOf<'getGroupState'> {}
export interface CastAddGroupMemberRequest extends CastRpcRequestOf<'addGroupMember'> {
    device: DlnaDevice;
}
export interface CastRemoveGroupMemberRequest extends CastRpcRequestOf<'removeGroupMember'> {
    deviceId: string;
}
export interface CastGetSpeakerPropertiesRequest
    extends CastRpcRequestOf<'getSpeakerProperties'> {
    deviceId: string;
}
export interface CastPrepareSpeedFileRequest extends CastRpcRequestOf<'prepareSpeedFile'> {
    data: SpeedFileData;
}
export interface CastCheckSpeedFileRequest extends CastRpcRequestOf<'checkSpeedFile'> {
    data: Omit<SpeedFileData, 'offset'>;
}

// ---- Server-authoritative session RPCs (Phase C-E) ----
// These are additive: the renderer uses them only when `isDlnaMode === true`
// (server owns the queue).  The Electron IPC path keeps using `playUrl` /
// `setNextUrl` and does not send these RPCs.

/**
 *  Song record carried in queue RPCs.  Extends the renderer's `QueueSong`
 *  with pre-resolved URLs/mimeType that the renderer computed at queue-add
 *  time — the server has no Navidrome API client of its own, so it can't
 *  resolve stream URLs or album-art URLs.  The renderer hands them in
 *  once and the server uses them as-is.
 */
export interface CastQueueSong extends QueueSong {
    /** Renderer-resolved stream URL for `playUrl` (already OPUS-transcoded
     *  to MP3 if needed, so the server can hand it to Sonos verbatim). */
    resolvedStreamUrl?: string;
    /** Renderer-resolved album art URL for DIDL-Lite metadata. */
    resolvedAlbumArtUrl?: string;
    /** Renderer-detected MIME type (e.g. `audio/mpeg`, `audio/flac`). */
    resolvedMimeType?: string;
}

/**
 *  Full queue snapshot, mirroring the shape of the renderer's `QueueData`
 *  (see `src/shared/types/domain-types.ts:69`).  Sent on `setQueue`,
 *  `getQueueState`-result, and the `rendererQueueState` event.
 */
export interface CastQueueSnapshot {
    /** Ordered list of uniqueIds in default (non-shuffled) order. */
    default: string[];
    /** Shuffle permutation (indexes into `default`), or `[]` if not shuffled. */
    shuffled: number[];
    /** Full song records keyed by uniqueId. */
    songs: Record<string, CastQueueSong>;
}

/**
 *  Authoritative player state held by the server when `isServerAuthoritative`
 *  is true.  Mirrors the `player` slice of the renderer's player store.
 */
export interface CastPlayerState {
    /** Current index into `shuffled` (if `shuffle !== 'none'`) or `default`. */
    index: number;
    status: PlayerStatus;
    repeat: PlayerRepeat;
    shuffle: PlayerShuffle;
    speed: number;
    volume: number;
    muted: boolean;
    /** Wall-clock seconds; -1 = no seek.  Maps to the renderer's
     *  `seekToTimestamp` (unique-stamped so engines can dedupe). */
    seekTo: number;
}

export interface CastSetQueueRequest extends CastRpcRequestOf<'setQueue'> {
    queue: CastQueueSnapshot;
    /** Optional player-state patch applied atomically with the queue. */
    playerState?: Partial<CastPlayerState>;
}
export interface CastQueueAddRequest extends CastRpcRequestOf<'queueAdd'> {
    songs: CastQueueSong[];
    playType: Play;
    playSongId?: string;
}
export interface CastQueueClearRequest extends CastRpcRequestOf<'queueClear'> {}
export interface CastQueueRemoveRequest extends CastRpcRequestOf<'queueRemove'> {
    uniqueIds: string[];
}
export interface CastQueueMoveRequest extends CastRpcRequestOf<'queueMove'> {
    uniqueIds: string[];
    targetUniqueId: string;
    edge: 'bottom' | 'top';
}
export interface CastQueueShuffleRequest extends CastRpcRequestOf<'queueShuffle'> {}
export interface CastSetPlayerStateRequest extends CastRpcRequestOf<'setPlayerState'> {
    status: PlayerStatus;
}
export interface CastSetRepeatRequest extends CastRpcRequestOf<'setRepeat'> {
    repeat: PlayerRepeat;
}
export interface CastSetShuffleRequest extends CastRpcRequestOf<'setShuffle'> {
    shuffle: PlayerShuffle;
}
export interface CastSetSpeedRequest extends CastRpcRequestOf<'setSpeed'> {
    speed: number;
}
export interface CastNextRequest extends CastRpcRequestOf<'next'> {
    toNextAlbum?: boolean;
}
export interface CastPreviousRequest extends CastRpcRequestOf<'previous'> {
    toPreviousAlbum?: boolean;
}
export interface CastPlayByIndexRequest extends CastRpcRequestOf<'playByIndex'> {
    index: number;
}
export interface CastPlayByUniqueIdRequest extends CastRpcRequestOf<'playByUniqueId'> {
    uniqueId: string;
}
export interface CastSeekRequest extends CastRpcRequestOf<'seek'> {
    seconds: number;
}
export interface CastSetVolumeRequest extends CastRpcRequestOf<'setVolume'> {
    volume: number;
}
export interface CastSetMutedRequest extends CastRpcRequestOf<'setMuted'> {
    muted: boolean;
}
export interface CastGetQueueStateRequest extends CastRpcRequestOf<'getQueueState'> {}

export type CastClientRpc =
    | CastDiscoverRequest
    | CastConnectRequest
    | CastDisconnectRequest
    | CastDisconnectPassiveRequest
    | CastGetPositionRequest
    | CastGetGroupStateRequest
    | CastAddGroupMemberRequest
    | CastRemoveGroupMemberRequest
    | CastGetSpeakerPropertiesRequest
    | CastPrepareSpeedFileRequest
    | CastCheckSpeedFileRequest
    | CastSetQueueRequest
    | CastQueueAddRequest
    | CastQueueClearRequest
    | CastQueueMoveRequest
    | CastQueueRemoveRequest
    | CastQueueShuffleRequest
    | CastSetPlayerStateRequest
    | CastSetRepeatRequest
    | CastSetShuffleRequest
    | CastSetSpeedRequest
    | CastNextRequest
    | CastPreviousRequest
    | CastPlayByIndexRequest
    | CastPlayByUniqueIdRequest
    | CastSeekRequest
    | CastSetVolumeRequest
    | CastSetMutedRequest
    | CastGetQueueStateRequest;

export type CastCommandMethod =
    | 'playUrl'
    | 'setNextUrl'
    | 'clearNextUrl'
    | 'play'
    | 'pause'
    | 'stop'
    | 'seek'
    | 'volume'
    | 'mute'
    | 'setRadioMode'
    | 'setGroupMemberVolume'
    | 'setGroupMemberMute'
    | 'setSpeakerProperty'
    | 'cancelSpeedFile'
    | 'destroySpeedProxy';

export interface CastCommand {
    v: 1;
    type: 'command';
    method: CastCommandMethod;
    [k: string]: unknown;
}

export interface CastPlayUrlCommand extends CastCommand {
    method: 'playUrl';
    url: string;
    metadata: import('/@/shared/types/dlna').TrackMetadata;
    opts?: { isMuted?: boolean; seekTo?: number };
}
export interface CastSetNextUrlCommand extends CastCommand {
    method: 'setNextUrl';
    url: string;
    metadata: import('/@/shared/types/dlna').TrackMetadata;
}
export interface CastClearNextUrlCommand extends CastCommand {
    method: 'clearNextUrl';
}
export interface CastPlayCommand extends CastCommand {
    method: 'play';
}
export interface CastPauseCommand extends CastCommand {
    method: 'pause';
}
export interface CastStopCommand extends CastCommand {
    method: 'stop';
}
export interface CastSeekCommand extends CastCommand {
    method: 'seek';
    seconds: number;
}
export interface CastVolumeCommand extends CastCommand {
    method: 'volume';
    value: number;
}
export interface CastMuteCommand extends CastCommand {
    method: 'mute';
    muted: boolean;
}
export interface CastSetRadioModeCommand extends CastCommand {
    method: 'setRadioMode';
    enabled: boolean;
}
export interface CastSetGroupMemberVolumeCommand extends CastCommand {
    method: 'setGroupMemberVolume';
    deviceId: string;
    volume: number;
}
export interface CastSetGroupMemberMuteCommand extends CastCommand {
    method: 'setGroupMemberMute';
    deviceId: string;
    muted: boolean;
}
export interface CastSetSpeakerPropertyCommand extends CastCommand {
    method: 'setSpeakerProperty';
    deviceId: string;
    property: keyof SpeakerProperties;
    value: boolean | number;
}
export interface CastCancelSpeedFileCommand extends CastCommand {
    method: 'cancelSpeedFile';
    data: Omit<SpeedFileData, 'offset'>;
}
export interface CastDestroySpeedProxyCommand extends CastCommand {
    method: 'destroySpeedProxy';
}

export type CastClientCommand =
    | CastPlayUrlCommand
    | CastSetNextUrlCommand
    | CastClearNextUrlCommand
    | CastPlayCommand
    | CastPauseCommand
    | CastStopCommand
    | CastSeekCommand
    | CastVolumeCommand
    | CastMuteCommand
    | CastSetRadioModeCommand
    | CastSetGroupMemberVolumeCommand
    | CastSetGroupMemberMuteCommand
    | CastSetSpeakerPropertyCommand
    | CastCancelSpeedFileCommand
    | CastDestroySpeedProxyCommand;

export interface CastPingMessage {
    v: 1;
    type: 'ping';
}

export type CastClientMessage = CastClientRpc | CastClientCommand | CastPingMessage;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface CastRpcOk<M extends CastRpcMethod> {
    v: 1;
    id: string;
    type: 'result';
    ok: true;
    method: M;
    result: CastRpcResult<M>;
}

export interface CastRpcError {
    v: 1;
    id: string;
    type: 'result';
    ok: false;
    error: { message: string; code?: string };
}

export type CastRpcResult<M extends CastRpcMethod> = M extends 'discover'
    ? { devices: DlnaDevice[] }
    : M extends 'connect'
      ? import('/@/shared/types/dlna').ConnectResult
      : M extends 'disconnect' | 'disconnectPassive'
        ? { ok: boolean }
        : M extends 'getPosition'
          ? { position: number }
          : M extends 'getGroupState'
            ? { state: GroupMember[] }
            : M extends 'addGroupMember' | 'removeGroupMember'
              ? { success: boolean }
              : M extends 'getSpeakerProperties'
                ? { properties: SpeakerProperties | null }
                : M extends 'prepareSpeedFile' | 'checkSpeedFile'
                  ? { url: string | null }
                  : M extends 'getQueueState'
                    ? { queue: CastQueueSnapshot; player: CastPlayerState }
                    : M extends
                          | 'setQueue'
                          | 'queueAdd'
                          | 'queueClear'
                          | 'queueMove'
                          | 'queueRemove'
                          | 'queueShuffle'
                          | 'setPlayerState'
                          | 'setRepeat'
                          | 'setShuffle'
                          | 'setSpeed'
                          | 'next'
                          | 'previous'
                          | 'playByIndex'
                          | 'playByUniqueId'
                          | 'seek'
                          | 'setVolume'
                          | 'setMuted'
                      ? { ok: boolean }
                      : never;

export interface CastHelloMessage {
    v: 1;
    type: 'hello';
    version: string;
    ffmpegPresent: boolean;
    connected: boolean;
    /** Snapshot of current playback state.  Present when `connected === true`
     *  and the device has a commanded URI or known transport state.  Used by
     *  a newly-connected client (e.g. a second browser tab) to mirror the
     *  active DLNA session without re-querying the device. */
    playback?: {
        duration: number;
        nextUri: string;
        position: number;
        transportState: string;
        uri: string;
    };
    /** Current device volume (0-100).  Present when `connected === true`. */
    volume?: number;
    /** Current group state.  Present when `connected === true` and the
     *  session is a Sonos group. */
    groupState?: GroupMember[];
    /** Full queue + player snapshot.  Present when `connected === true`
     *  and the server is authoritative for the DLNA session (i.e. at
     *  least one client has sent `setQueue` to enable server-owned
     *  queue/state mode).  Used by a newly-connected client (e.g. a
     *  second browser tab) to mirror the session without re-querying. */
    queueState?: { queue: CastQueueSnapshot; player: CastPlayerState };
}

export interface CastPongMessage {
    v: 1;
    type: 'pong';
}

export type CastEventName =
    | 'rendererCurrentTime'
    | 'rendererDlnaTrackEnded'
    | 'rendererDlnaConnectPlayback'
    | 'rendererDlnaTransportState'
    | 'rendererDlnaPrevTrack'
    | 'rendererDlnaVolume'
    | 'rendererDlnaToast'
    | 'rendererDlnaGroupState'
    | 'rendererDlnaGroupMemberVolume'
    | 'rendererDlnaDiscoveryUpdate'
    // ---- Server-authoritative session events (Phase C-E) ----
    /** Full queue + player snapshot; sent on initial sync, reconnection,
     *  and structural queue changes.  See CastQueueSnapshot / CastPlayerState. */
    | 'rendererQueueState'
    /** Partial player-state update (index/status/volume/etc only); sent
     *  for normal player field changes that don't reorder the queue. */
    | 'rendererPlayerState';

export interface CastEvent {
    v: 1;
    type: 'event';
    event: CastEventName;
    data: unknown;
}

export type CastServerMessage =
    | CastRpcOk<CastRpcMethod>
    | CastRpcError
    | CastHelloMessage
    | CastPongMessage
    | CastEvent;

// ---------------------------------------------------------------------------
// Event payload types (one per CastEventName)
// ---------------------------------------------------------------------------

export interface CastEventPayloads {
    rendererCurrentTime: number;
    rendererDlnaTrackEnded: void;
    rendererDlnaConnectPlayback: ConnectPlaybackInfo;
    rendererDlnaTransportState: string;
    rendererDlnaPrevTrack: void;
    rendererDlnaVolume: number;
    rendererDlnaToast: DlnaToastPayload;
    rendererDlnaGroupState: GroupMember[];
    rendererDlnaGroupMemberVolume: GroupMemberVolumePayload;
    rendererDlnaDiscoveryUpdate: DlnaDevice[];
    // ---- Server-authoritative session events (Phase C-E) ----
    rendererQueueState: { player: CastPlayerState; queue: CastQueueSnapshot };
    rendererPlayerState: Partial<CastPlayerState>;
}

/** WebSocket close codes used by the casting server. */
export const CastCloseCode = {
    SHUTDOWN: 4000,
    AUTH_FAILED: 4001,
    AUTH_CHANGED: 4002,
    TIMEOUT: 4003,
    NATURAL_CLOSE: 4001, // client-initiated
} as const;
