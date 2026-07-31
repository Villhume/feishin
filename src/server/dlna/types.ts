/**
 * Internal types for the standalone casting server.
 */

import type {
    CastPlayerState,
    CastQueueSnapshot,
    CastQueueSong,
} from '/@/shared/types/cast-types';
import type { DlnaDevice } from '/@/shared/types/dlna';
import type { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

/**
 * The current connection state of the controller, sent on WS `hello`
 * and used to decide whether to emit a synthetic `rendererDlnaConnectPlayback`
 * event to reconnecting clients.
 */
export interface ControllerState {
    connectedDevice: DlnaDevice | null;
}

export interface ControllerLike {
    /** All RPC methods that the WS transport routes to. */
    discover: () => Promise<DlnaDevice[]>;
    connect: (device: DlnaDevice) => Promise<import('/@/shared/types/dlna').ConnectResult>;
    disconnect: () => Promise<boolean>;
    disconnectPassive: () => Promise<boolean>;
    getPosition: () => Promise<number>;
    getGroupState: () => Promise<import('/@/shared/types/dlna').GroupMember[]>;
    addGroupMember: (device: DlnaDevice) => Promise<{ success: boolean }>;
    removeGroupMember: (deviceId: string) => Promise<{ success: boolean }>;
    getSpeakerProperties: (
        deviceId: string,
    ) => Promise<import('/@/shared/types/dlna').SpeakerProperties | null>;
    prepareSpeedFile: (
        data: import('/@/shared/types/dlna').SpeedFileData,
    ) => Promise<string | null>;
    checkSpeedFile: (
        data: Omit<import('/@/shared/types/dlna').SpeedFileData, 'offset'>,
    ) => Promise<string | null>;

    // fire-and-forget commands
    playUrl: (
        url: string,
        metadata: import('/@/shared/types/dlna').TrackMetadata,
        opts?: { isMuted?: boolean; seekTo?: number },
    ) => void;
    setNextUrl: (
        url: string,
        metadata: import('/@/shared/types/dlna').TrackMetadata,
    ) => void;
    clearNextUrl: () => void;
    play: () => void;
    pause: () => void;
    stop: () => void;
    seek: (seconds: number) => void;
    volume: (value: number) => void;
    mute: (muted: boolean) => void;
    setRadioMode: (enabled: boolean) => void;
    setGroupMemberVolume: (deviceId: string, volume: number) => void;
    setGroupMemberMute: (deviceId: string, muted: boolean) => void;
    setSpeakerProperty: (
        deviceId: string,
        property: keyof import('/@/shared/types/dlna').SpeakerProperties,
        value: boolean | number,
    ) => void;
    cancelSpeedFile: (data: Omit<import('/@/shared/types/dlna').SpeedFileData, 'offset'>) => void;
    destroySpeedProxy: () => void;

    /** True if a device is currently connected (used to drive `hello.connected`). */
    isConnected: () => boolean;
    /** True if ffmpeg is available (used to drive `hello.ffmpegPresent` and `/health`). */
    hasFfmpeg: () => boolean;
    /**
     *  True if the server is authoritative for queue + player state (set
     *  true on first `setQueue` RPC; cleared on disconnect).  Used by
     *  the WS transport to decide whether to send `queueState` in the
     *  hello snapshot and whether to skip the legacy 500ms-delayed
     *  event block (the queue snapshot supersedes it).
     */
    isServerAuthoritative: () => boolean;

    // ------------------------------------------------------------------
    // Server-authoritative session RPCs (Phase D)
    // ------------------------------------------------------------------
    /** Replace the entire queue + optionally patch player state. */
    setQueue: (queue: CastQueueSnapshot, playerState?: Partial<CastPlayerState>) => Promise<{ ok: boolean }>;
    /** Append songs at the current position / replace queue (see Play enum). */
    queueAdd: (
        songs: CastQueueSong[],
        playType: Play,
        playSongId?: string,
    ) => Promise<{ ok: boolean }>;
    /** Remove songs by uniqueId. */
    queueRemove: (uniqueIds: string[]) => Promise<{ ok: boolean }>;
    /** Reorder songs to before/after the target. */
    queueMove: (
        uniqueIds: string[],
        targetUniqueId: string,
        edge: 'bottom' | 'top',
    ) => Promise<{ ok: boolean }>;
    /** Turn on track shuffle. */
    queueShuffleAll: () => Promise<{ ok: boolean }>;
    /** Clear the queue entirely. */
    queueClear: () => Promise<{ ok: boolean }>;
    /** Advance to the next track (handled by the server session). */
    sessionNext: (toNextAlbum?: boolean) => Promise<{ ok: boolean }>;
    /** Advance to the previous track (handled by the server session). */
    sessionPrevious: (toPreviousAlbum?: boolean) => Promise<{ ok: boolean }>;
    /** Jump to a specific queue index. */
    sessionPlayByIndex: (index: number) => Promise<{ ok: boolean }>;
    /** Jump to a specific song by uniqueId. */
    sessionPlayByUniqueId: (uniqueId: string) => Promise<{ ok: boolean }>;
    /** Set transport status (PLAYING / PAUSED / STOPPED). */
    sessionSetStatus: (status: PlayerStatus) => Promise<{ ok: boolean }>;
    /** Set repeat mode. */
    sessionSetRepeat: (repeat: PlayerRepeat) => Promise<{ ok: boolean }>;
    /** Set shuffle mode. */
    sessionSetShuffle: (shuffle: PlayerShuffle) => Promise<{ ok: boolean }>;
    /** Set playback speed (triggers transcode if ≠ 1). */
    sessionSetSpeed: (speed: number) => Promise<{ ok: boolean }>;
    /** Set master volume (0-100). */
    sessionSetVolume: (volume: number) => Promise<{ ok: boolean }>;
    /** Set master mute. */
    sessionSetMuted: (muted: boolean) => Promise<{ ok: boolean }>;
    /** Seek to a wall-clock seconds offset. */
    sessionSeek: (seconds: number) => Promise<{ ok: boolean }>;
    /** Read the full snapshot. */
    getQueueState: () => { queue: CastQueueSnapshot; player: CastPlayerState };
    /**
     *  Returns a cached snapshot of playback state (current track URI,
     *  position, duration, transport state, volume, and group members)
     *  for the currently-connected session, or `null` values if not
     *  connected.  Used by the WS transport to synchronise a newly
     *  connected client without re-querying the device.
     */
    getPlaybackSnapshot: () => {
        groupState: import('/@/shared/types/dlna').GroupMember[];
        playback: null | {
            duration: number;
            nextUri: string;
            position: number;
            transportState: string;
            uri: string;
        };
        volume: number;
    };
    /** Subscribe to controller-emitted events (mirrors the 11 dlnaPlayerListener channels). */
    on: (event: import('/@/shared/types/cast-types').CastEventName, cb: (data: unknown) => void) => void;
}

export interface TransportLogger {
    info: (action: string, err?: unknown) => void;
}
