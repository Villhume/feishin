import type { CastEventName } from '/@/shared/types/cast-types';
import type {
    DlnaDevice,
    SpeakerProperties,
    SpeedFileData,
    TrackMetadata,
} from '/@/shared/types/dlna';

/**
 * Electron IPC shim for DLNA casting.
 *
 * This file is a thin adapter between the main process IPC channels
 * (registered here) and the `DlnaController` class that lives in
 * `src/server/dlna/controller.ts`. The controller is process-agnostic
 * (no Electron imports); this shim wires it into Electron's IPC and
 * event-forwarding machinery.
 *
 * Channel list and event names mirror `src/preload/dlna-player.ts`.
 */
import { ipcMain } from 'electron';

import { getMainWindow } from '../../../index';

import log from '/@/main/logger';
import { DlnaController } from '/@/server/dlna/controller';

export type { SpeakerProperties };

let controllerPromise: null | Promise<DlnaController> = null;

/** Lazily construct the singleton controller. Subsequent calls reuse it. */
function getController(): Promise<DlnaController> {
    if (!controllerPromise) {
        controllerPromise = Promise.resolve(
            new DlnaController({
                disableEventSubscription: process.platform === 'darwin',
                logger: { info: (action, err) => log.info(action, err) },
            }),
        );
    }
    return controllerPromise;
}

// ------------------------------------------------------------------
// Event forwarding: controller emits → main window sends to renderer
// ------------------------------------------------------------------

const FORWARDED_EVENTS: ReadonlyArray<{ channel: string; event: CastEventName }> = [
    { channel: 'renderer-dlna-current-time', event: 'rendererCurrentTime' },
    { channel: 'renderer-dlna-track-ended', event: 'rendererDlnaTrackEnded' },
    { channel: 'renderer-dlna-connect-playback', event: 'rendererDlnaConnectPlayback' },
    { channel: 'renderer-dlna-transport-state', event: 'rendererDlnaTransportState' },
    { channel: 'renderer-dlna-prev-track', event: 'rendererDlnaPrevTrack' },
    { channel: 'renderer-dlna-volume', event: 'rendererDlnaVolume' },
    { channel: 'renderer-dlna-toast', event: 'rendererDlnaToast' },
    { channel: 'renderer-dlna-group-state', event: 'rendererDlnaGroupState' },
    { channel: 'renderer-dlna-group-member-volume', event: 'rendererDlnaGroupMemberVolume' },
    { channel: 'renderer-dlna-discovery-update', event: 'rendererDlnaDiscoveryUpdate' },
];

void getController().then((c) => {
    for (const { channel, event } of FORWARDED_EVENTS) {
        c.on(event, (data: unknown) => {
            getMainWindow()?.webContents.send(channel, data);
        });
    }
});

// ------------------------------------------------------------------
// Discovery & connection
// ------------------------------------------------------------------

ipcMain.handle('dlna-discover', async () => {
    const c = await getController();
    return c.discover();
});

ipcMain.handle('dlna-connect', async (_event, device: DlnaDevice) => {
    const c = await getController();
    return c.connect(device);
});

ipcMain.handle('dlna-disconnect', async () => {
    const c = await getController();
    return c.disconnect();
});

ipcMain.handle('dlna-disconnect-passive', async () => {
    const c = await getController();
    return c.disconnectPassive();
});

// ------------------------------------------------------------------
// Groups
// ------------------------------------------------------------------

ipcMain.handle('dlna-group-add-member', async (_event, device: DlnaDevice) => {
    const c = await getController();
    return c.addGroupMember(device);
});

ipcMain.handle('dlna-group-remove-member', async (_event, deviceId: string) => {
    const c = await getController();
    return c.removeGroupMember(deviceId);
});

ipcMain.on(
    'dlna-group-member-volume',
    async (_event, payload: { deviceId: string; volume: number }) => {
        const c = await getController();
        c.setGroupMemberVolume(payload.deviceId, payload.volume);
    },
);

ipcMain.on(
    'dlna-group-member-mute',
    async (_event, payload: { deviceId: string; muted: boolean }) => {
        const c = await getController();
        c.setGroupMemberMute(payload.deviceId, payload.muted);
    },
);

ipcMain.handle('dlna-group-get-state', async () => {
    const c = await getController();
    return c.getGroupState();
});

// ------------------------------------------------------------------
// Mode
// ------------------------------------------------------------------

ipcMain.on('dlna-set-radio-mode', (_event, enabled: boolean) => {
    void getController().then((c) => c.setRadioMode(enabled));
});

// ------------------------------------------------------------------
// Playback commands
// ------------------------------------------------------------------

ipcMain.on(
    'dlna-play-url',
    (
        _event,
        data: { isMuted?: boolean; metadata: TrackMetadata; seekTo?: number; url: string },
    ) => {
        void getController().then((c) =>
            c.playUrl(data.url, data.metadata, { isMuted: data.isMuted, seekTo: data.seekTo }),
        );
    },
);

ipcMain.on('dlna-set-next-url', async (_event, data: { metadata: TrackMetadata; url: string }) => {
    const c = await getController();
    c.setNextUrl(data.url, data.metadata);
});

ipcMain.on('dlna-clear-next', async () => {
    const c = await getController();
    c.clearNextUrl();
});

ipcMain.on('dlna-play', () => {
    void getController().then((c) => c.play());
});

ipcMain.on('dlna-pause', () => {
    void getController().then((c) => c.pause());
});

ipcMain.on('dlna-stop', () => {
    void getController().then((c) => c.stop());
});

ipcMain.on('dlna-seek', async (_event, seconds: number) => {
    const c = await getController();
    c.seek(seconds);
});

ipcMain.on('dlna-volume', async (_event, value: number) => {
    const c = await getController();
    c.volume(value);
});

ipcMain.on('dlna-mute', async (_event, muted: boolean) => {
    const c = await getController();
    c.mute(muted);
});

ipcMain.handle('dlna-get-position', async () => {
    const c = await getController();
    return c.getPosition();
});

// ------------------------------------------------------------------
// Speaker properties
// ------------------------------------------------------------------

ipcMain.handle('dlna-get-speaker-properties', async (_event, deviceId: string) => {
    const c = await getController();
    return c.getSpeakerProperties(deviceId);
});

ipcMain.on(
    'dlna-set-speaker-property',
    async (
        _event,
        payload: { deviceId: string; property: keyof SpeakerProperties; value: boolean | number },
    ) => {
        const c = await getController();
        c.setSpeakerProperty(payload.deviceId, payload.property, payload.value);
    },
);

// ------------------------------------------------------------------
// Speed transcoding
// ------------------------------------------------------------------

ipcMain.handle('dlna-prepare-speed-file', async (_event, data: SpeedFileData) => {
    const c = await getController();
    return c.prepareSpeedFile(data);
});

ipcMain.handle('dlna-check-speed-file', async (_event, data: Omit<SpeedFileData, 'offset'>) => {
    const c = await getController();
    return c.checkSpeedFile(data);
});

ipcMain.on('dlna-cancel-speed-file', async (_event, data: Omit<SpeedFileData, 'offset'>) => {
    const c = await getController();
    c.cancelSpeedFile(data);
});

ipcMain.on('dlna-create-speed-proxy', async (_event, _data: SpeedFileData) => {
    // The preload exposes `createSpeedProxy` for legacy reasons, but no
    // renderer code uses it. We no-op on the controller side — the
    // `dlna-destroy-speed-proxy` handler in the controller cleans up any
    // active proxy work via `transcoder.stopSpeedProxy()`.
});

ipcMain.on('dlna-destroy-speed-proxy', () => {
    void getController().then((c) => c.destroySpeedProxy());
});
