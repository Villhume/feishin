import type {
    ConnectResult,
    DlnaDevice,
    GroupMember,
    SpeakerProperties,
    SpeedFileData,
    TrackMetadata,
} from '/@/shared/types/dlna';

import { ipcRenderer, IpcRendererEvent } from 'electron';

export type { ConnectResult, DlnaDevice, GroupMember, SpeakerProperties, TrackMetadata };

const discover = (): Promise<DlnaDevice[]> => ipcRenderer.invoke('dlna-discover');
const connect = (device: DlnaDevice): Promise<ConnectResult> =>
    ipcRenderer.invoke('dlna-connect', device);
const disconnect = (): Promise<boolean> => ipcRenderer.invoke('dlna-disconnect');
const disconnectPassive = (): Promise<boolean> => ipcRenderer.invoke('dlna-disconnect-passive');
const playUrl = (
    url: string,
    metadata: TrackMetadata,
    options?: { isMuted?: boolean; seekTo?: number },
) => ipcRenderer.send('dlna-play-url', { metadata, url, ...options });
const setNextUrl = (url: string, metadata: TrackMetadata) =>
    ipcRenderer.send('dlna-set-next-url', { metadata, url });
const clearNextUrl = () => ipcRenderer.send('dlna-clear-next');
const play = () => ipcRenderer.send('dlna-play');
const pause = () => ipcRenderer.send('dlna-pause');
const stop = () => ipcRenderer.send('dlna-stop');
const seek = (seconds: number) => ipcRenderer.send('dlna-seek', seconds);
const volume = (value: number) => ipcRenderer.send('dlna-volume', value);
const mute = (muted: boolean) => ipcRenderer.send('dlna-mute', muted);
const getPosition = (): Promise<number> => ipcRenderer.invoke('dlna-get-position');
const setRadioMode = (enabled: boolean) => ipcRenderer.send('dlna-set-radio-mode', enabled);
const addGroupMember = (device: DlnaDevice): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('dlna-group-add-member', device);
const removeGroupMember = (deviceId: string): Promise<{ success: boolean }> =>
    ipcRenderer.invoke('dlna-group-remove-member', deviceId);
const setGroupMemberVolume = (deviceId: string, vol: number) =>
    ipcRenderer.send('dlna-group-member-volume', { deviceId, volume: vol });
const setGroupMemberMute = (deviceId: string, muted: boolean) =>
    ipcRenderer.send('dlna-group-member-mute', { deviceId, muted });
const getGroupState = (): Promise<GroupMember[]> => ipcRenderer.invoke('dlna-group-get-state');
function singleOn<T extends (...args: any[]) => void>(channel: string, cb: T): void {
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, cb);
}

const rendererCurrentTime = (cb: (event: IpcRendererEvent, time: number) => void) =>
    singleOn('renderer-dlna-current-time', cb);
const rendererDlnaTrackEnded = (cb: (event: IpcRendererEvent) => void) =>
    singleOn('renderer-dlna-track-ended', cb);
const rendererTrackEnded = rendererDlnaTrackEnded;
const rendererDlnaConnectPlayback = (
    cb: (
        event: IpcRendererEvent,
        info: {
            duration: number;
            nextUri: string;
            position: number;
            transportState: string;
            uri: string;
        },
    ) => void,
) => singleOn('renderer-dlna-connect-playback', cb);
const rendererDlnaTransportState = (cb: (event: IpcRendererEvent, state: string) => void) =>
    singleOn('renderer-dlna-transport-state', cb);
const rendererDlnaPrevTrack = (cb: (event: IpcRendererEvent) => void) =>
    singleOn('renderer-dlna-prev-track', cb);
const rendererDlnaVolume = (cb: (event: IpcRendererEvent, volume: number) => void) =>
    singleOn('renderer-dlna-volume', cb);
const rendererDlnaToast = (
    cb: (
        event: IpcRendererEvent,
        payload: { message: string; type: 'error' | 'info' | 'warning' },
    ) => void,
) => singleOn('renderer-dlna-toast', cb);
const rendererDlnaGroupState = (cb: (event: IpcRendererEvent, state: GroupMember[]) => void) =>
    singleOn('renderer-dlna-group-state', cb);
const rendererDlnaGroupMemberVolume = (
    cb: (event: IpcRendererEvent, payload: { deviceId: string; volume: number }) => void,
) => singleOn('renderer-dlna-group-member-volume', cb);
const rendererDlnaDiscoveryUpdate = (
    cb: (event: IpcRendererEvent, devices: DlnaDevice[]) => void,
) => singleOn('renderer-dlna-discovery-update', cb);
const prepareSpeedFile = (data: SpeedFileData) =>
    ipcRenderer.invoke('dlna-prepare-speed-file', data);
const checkSpeedFile = (data: Omit<SpeedFileData, 'offset'>): Promise<null | string> =>
    ipcRenderer.invoke('dlna-check-speed-file', data);
const cancelSpeedFile = (data: Omit<SpeedFileData, 'offset'>) =>
    ipcRenderer.send('dlna-cancel-speed-file', data);

const getSpeakerProperties = (deviceId: string): Promise<null | SpeakerProperties> =>
    ipcRenderer.invoke('dlna-get-speaker-properties', deviceId);
const createSpeedProxy = (data: SpeedFileData): Promise<null | string> =>
    ipcRenderer.invoke('dlna-create-speed-proxy', data);
const destroySpeedProxy = () => ipcRenderer.send('dlna-destroy-speed-proxy');

const setSpeakerProperty = (
    deviceId: string,
    property: keyof SpeakerProperties,
    value: boolean | number,
) => ipcRenderer.send('dlna-set-speaker-property', { deviceId, property, value });

export const dlnaPlayer = {
    addGroupMember,
    cancelSpeedFile,
    checkSpeedFile,
    clearNextUrl,
    connect,
    createSpeedProxy,
    destroySpeedProxy,
    disconnect,
    disconnectPassive,
    discover,
    getGroupState,
    getPosition,
    getSpeakerProperties,
    mute,
    pause,
    play,
    playUrl,
    prepareSpeedFile,
    removeGroupMember,
    seek,
    setGroupMemberMute,
    setGroupMemberVolume,
    setNextUrl,
    setRadioMode,
    setSpeakerProperty,
    stop,
    volume,
};

export const dlnaPlayerListener = {
    rendererCurrentTime,
    rendererDlnaConnectPlayback,
    rendererDlnaDiscoveryUpdate,
    rendererDlnaGroupMemberVolume,
    rendererDlnaGroupState,
    rendererDlnaPrevTrack,
    rendererDlnaToast,
    rendererDlnaTrackEnded,
    rendererDlnaTransportState,
    rendererDlnaVolume,
    rendererPlayerState: (_cb: never) => {
        // Server-authoritative session events (Phase D) are WS-only — the
        // Electron IPC path never fires them. Stub included so the
        // adapter's `dlnaPlayerListener[event](wrapped)` indexing
        // typechecks when called with these event names (which it never is).
    },
    rendererQueueState: (_cb: never) => {
        // See rendererPlayerState above — same rationale.
    },
    rendererTrackEnded,
};

export type DlnaPlayer = typeof dlnaPlayer;

export type DlnaPlayerListener = typeof dlnaPlayerListener;
