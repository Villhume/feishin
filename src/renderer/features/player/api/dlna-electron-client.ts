/**
 * Electron-backed DlnaClient adapter.
 *
 * Wraps window.api.dlnaPlayer (methods) and window.api.dlnaPlayerListener
 * (event subscribers) from src/preload/dlna-player.ts. This is a thin
 * adapter — zero behavioral change versus the existing renderer code.
 *
 * Key differences from the raw preload API:
 *   - Event subscribers DROP the Electron `IpcRendererEvent` first arg.
 *     Callers receive only the payload.
 *   - Each subscriber returns an `unsubscribe` function that calls
 *     ipc.removeAllListeners(channel), replacing the useEffect cleanup
 *     pattern scattered across the renderer.
 *
 * Availability: requires isElectron(). The renderer should check this
 * before calling — null client means "DLNA unavailable".
 */
import type { DlnaClient, DlnaClientEvents, DlnaEventName, Unsubscribe } from './dlna-client';

interface ElectronApi {
    dlnaPlayer: typeof window.api.dlnaPlayer;
    dlnaPlayerListener: typeof window.api.dlnaPlayerListener;
    ipc: {
        removeAllListeners(channel: string): void;
    };
}

/**
 * Event name → corresponding IPC channel. Keep in sync with
 * src/preload/dlna-player.ts:54-90 (`singleOn` calls inside the preload).
 */
const EVENT_CHANNELS: Record<DlnaEventName, string> = {
    rendererCurrentTime: 'renderer-dlna-current-time',
    rendererDlnaConnectPlayback: 'renderer-dlna-connect-playback',
    rendererDlnaDiscoveryUpdate: 'renderer-dlna-discovery-update',
    rendererDlnaGroupMemberVolume: 'renderer-dlna-group-member-volume',
    rendererDlnaGroupState: 'renderer-dlna-group-state',
    rendererDlnaPrevTrack: 'renderer-dlna-prev-track',
    rendererDlnaToast: 'renderer-dlna-toast',
    rendererDlnaTrackEnded: 'renderer-dlna-track-ended',
    rendererDlnaTransportState: 'renderer-dlna-transport-state',
    rendererDlnaVolume: 'renderer-dlna-volume',
    // Server-authoritative session events (Phase D) — WS-only. The Electron
    // IPC path never fires these; the channels are placeholders to satisfy
    // the Record<DlnaEventName, string> constraint. They are never
    // subscribed to.
    rendererPlayerState: 'renderer-player-state',
    rendererQueueState: 'renderer-queue-state',
};

export function createElectronDlnaClient(api: ElectronApi): DlnaClient {
    const { dlnaPlayer, dlnaPlayerListener, ipc } = api;

    const on = <E extends DlnaEventName>(event: E, cb: DlnaClientEvents[E]): Unsubscribe => {
        const channel = EVENT_CHANNELS[event];
        // The preload's `singleOn` already removes all prior listeners
        // for this channel before attaching `cb`, so calling `on` a
        // second time replaces the previous subscriber in-place.
        // `dlnaPlayerListener` proxy signatures include the IpcRendererEvent
        // first arg — we strip it with a wrapper for the transport-agnostic
        // interface.
        const wrapped = ((...args: unknown[]) => {
            // args[0] is the IpcRendererEvent; args[1..] is the payload.
            const payload = args.slice(1);
            (cb as (...p: unknown[]) => void)(...payload);
        }) as never;
        dlnaPlayerListener[event](wrapped);
        return () => ipc.removeAllListeners(channel);
    };

    return {
        addGroupMember: (device) => dlnaPlayer.addGroupMember(device),
        cancelSpeedFile: (data) => dlnaPlayer.cancelSpeedFile(data),
        checkSpeedFile: (data) => dlnaPlayer.checkSpeedFile(data),
        clearNextUrl: () => dlnaPlayer.clearNextUrl(),
        connect: (device) => dlnaPlayer.connect(device),
        destroySpeedProxy: () => dlnaPlayer.destroySpeedProxy(),
        disconnect: () => dlnaPlayer.disconnect(),
        disconnectPassive: () => dlnaPlayer.disconnectPassive(),
        discover: () => dlnaPlayer.discover(),
        getGroupState: () => dlnaPlayer.getGroupState(),
        getPosition: () => dlnaPlayer.getPosition(),
        getSpeakerProperties: (deviceId) => dlnaPlayer.getSpeakerProperties(deviceId),
        // The Electron IPC path never participates in server-authoritative
        // sessions — `isWsClient: false` causes the renderer store to take
        // the legacy local-mutation + `playUrl` path for all player actions.
        // The session RPC stubs are unreachable but required to satisfy the
        // `DlnaClient` interface.
        isWsClient: false,
        mute: (muted) => dlnaPlayer.mute(muted),
        next: () => Promise.reject(new Error('session RPCs not supported on Electron client')),
        on,
        pause: () => dlnaPlayer.pause(),
        play: () => dlnaPlayer.play(),
        playByIndex: () => Promise.reject(new Error('not supported')),
        playByUniqueId: () => Promise.reject(new Error('not supported')),
        playUrl: (url, metadata, opts) => dlnaPlayer.playUrl(url, metadata, opts),
        prepareSpeedFile: (data) => dlnaPlayer.prepareSpeedFile(data),
        previous: () => Promise.reject(new Error('not supported')),
        queueAdd: () => Promise.reject(new Error('not supported')),
        queueClear: () => Promise.reject(new Error('not supported')),
        queueMove: () => Promise.reject(new Error('not supported')),
        queueRemove: () => Promise.reject(new Error('not supported')),
        queueShuffle: () => Promise.reject(new Error('not supported')),
        removeGroupMember: (deviceId) => dlnaPlayer.removeGroupMember(deviceId),
        seek: (seconds) => dlnaPlayer.seek(seconds),
        sessionPause: () => Promise.reject(new Error('not supported')),
        sessionPlay: () => Promise.reject(new Error('not supported')),
        sessionSeek: () => Promise.reject(new Error('not supported')),
        sessionSetMuted: () => Promise.reject(new Error('not supported')),
        sessionSetRepeat: () => Promise.reject(new Error('not supported')),
        sessionSetShuffle: () => Promise.reject(new Error('not supported')),
        sessionSetSpeed: () => Promise.reject(new Error('not supported')),
        sessionSetStatus: () => Promise.reject(new Error('not supported')),
        sessionSetVolume: () => Promise.reject(new Error('not supported')),
        sessionStop: () => Promise.reject(new Error('not supported')),
        setGroupMemberMute: (deviceId, muted) => dlnaPlayer.setGroupMemberMute(deviceId, muted),
        setGroupMemberVolume: (deviceId, vol) => dlnaPlayer.setGroupMemberVolume(deviceId, vol),
        setNextUrl: (url, metadata) => dlnaPlayer.setNextUrl(url, metadata),
        setQueue: () => Promise.reject(new Error('not supported')),
        setRadioMode: (enabled) => dlnaPlayer.setRadioMode(enabled),
        setSpeakerProperty: (deviceId, property, value) =>
            dlnaPlayer.setSpeakerProperty(deviceId, property, value),
        stop: () => dlnaPlayer.stop(),
        volume: (value) => dlnaPlayer.volume(value),
        getQueueState: () => Promise.reject(new Error('not supported')),
    };
}
