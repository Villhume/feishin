import type { CastPlayerState, CastQueueSnapshot, CastQueueSong } from '/@/shared/types/cast-types';
import type {
    ConnectResult,
    DlnaDevice,
    GroupMember,
    SpeakerProperties,
    SpeedFileData,
    TrackMetadata,
} from '/@/shared/types/dlna';

/**
 * DlnaController — the core of the DLNA casting feature.
 *
 * Extracted verbatim from src/main/features/core/dlna/index.ts (Phase 4).
 * All module-level state became private fields; all helper functions
 * became methods; all `ipcMain.handle/on` registrations became public
 * methods matching the `ControllerLike` interface; all
 * `getMainWindow()?.webContents.send(channel, payload)` calls became
 * `this.emit(channel, payload)`.
 *
 * The class extends `EventEmitter` so the WS transport (and the Electron
 * IPC shim) can subscribe to the 10 renderer-bound event channels via
 * `controller.on(event, cb)`.
 *
 * Subtle invariants preserved from the original:
 *  - Position polling is 500 ms (not 1 s).
 *  - Gapless detection combines URI change, position jump, transport
 *    state STOPPED, and UPnP events.
 *  - Resume-kick fires up to 4 times on stream-drop within the first
 *    15 s of a track (longer grace period applies for 15-30 s).
 *  - Group topology verification uses exponential backoff (5 s → 30 s)
 *    and trusts event-driven updates only after verification.
 *  - Event subscription is skipped when `disableEventSubscription` is
 *    set (Docker bridge mode or macOS).
 *
 * Server-authoritative session (Phase D):
 *  When `isServerAuthoritative` is true (set by the first `setQueue`
 *  RPC), the server owns the queue + player state via `DlnaSessionState`.
 *  User actions come in as RPCs (`sessionNext`, `setRepeat`, etc.), the
 *  controller mutates the session, re-issues `playUrl` to the device for
 *  track-changing operations (via `sendCurrentTrackFromSession`), and
 *  broadcasts `rendererQueueState` (structural changes) or
 *  `rendererPlayerState` (player-field patches) to all connected WS
 *  clients.  The renderer's local store is a mirror, not a source of
 *  truth in this mode.  LOCAL/WEB playback is unaffected.
 */
import { EventEmitter } from 'events';
import http from 'http';

import type { ControllerLike } from './types';

import { EventServer } from './event-server';
import { createNetworkHelpers } from './network';
import { DlnaSessionState } from './session-state';
import {
    becomeCoordinatorOfStandaloneGroup,
    clearNextAVTransportURI,
    getBass,
    getButtonLockState,
    getCrossfadeMode,
    getLEDState,
    getLoudness,
    getMediaInfo,
    getPositionInfo,
    getRinconId,
    getTopologyEventUrl,
    getTransportInfo,
    getTreble,
    getVolume,
    joinGroup,
    pause,
    play,
    seek,
    setAVTransportURI,
    setBass,
    setButtonLockState,
    setCrossfadeMode,
    setLEDState,
    setLoudness,
    setMute,
    setNextAVTransportURI,
    setSoapLogger,
    setTreble,
    setVolume,
    stop,
} from './soap-client';
import { discoverDevices } from './ssdp-discovery';
import { createTopologyHelpers } from './topology';
import { Transcoder } from './transcoding';

import { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

export interface DlnaControllerConfig {
    /** Skip UPnP event subscription (Docker bridge mode / macOS). */
    disableEventSubscription: boolean;
    /**
     *  External HTTP server to attach the EventServer's routes to
     *  (see `EventServerOptions.externalServer`).  When provided, the
     *  EventServer will NOT open its own random-port server — speed-
     *  transcode URLs and UPnP SUBSCRIBE callback URLs will use
     *  `eventServerHttp.port` (e.g. 8180, firewall-allowlisted).
     */
    eventServerHttp?: { port: number; server: import('http').Server };
    /** Optional ffmpeg binary path override. */
    ffmpegPath?: string;
    /** Logger used for all DLNA activity. */
    logger: { info: (action: string, err?: unknown) => void };
    /** Optional override for the host IP that DLNA devices should call back to. */
    overrideLanIp?: string;
}

type LoggerFn = (action: string, err?: unknown) => void;

export class DlnaController extends EventEmitter implements ControllerLike {
    private readonly config: DlnaControllerConfig;
    // --- connection state ---
    private connectedDevice: DlnaDevice | null = null;
    private currentCoordinatorId = '';
    // --- singletons wired in constructor ---
    private readonly dlnaLog: LoggerFn;
    private readonly eventServer: EventServer;
    private expectedGroupMemberCount = -1;
    private groupMembers: DlnaDevice[] = [];
    private groupMemberVolumes: Record<string, number> = {};
    private hasStartedPlaying = false;
    private isPausedIntentionally = false;
    private isRadioMode = false;
    private lastAppSeekAt = 0;
    private lastClearNextAt = 0;
    private lastCommandedUri = '';
    private lastFinishedUri = '';
    private lastKnownDeviceVolume = -1;
    private lastKnownDuration = 0;
    private lastKnownPosition = 0;
    private lastKnownTransportState = '';
    private lastLoadedFromUri = '';
    private lastPauseCommandAt = 0;
    private lastPlayCommandAt = 0;
    private lastPlayUrlSentAt = 0;
    private lastQueuedNextUri = '';
    private nearEndStallCount = 0;
    private readonly networkHelpers: ReturnType<typeof createNetworkHelpers>;
    private pendingPrevTrack = false;
    private pendingTopologyRefreshTimeout: NodeJS.Timeout | null = null;
    private positionPollingInterval: NodeJS.Timeout | null = null;
    private resumeKickCount = 0;
    /**
     *  Generation counter for `sendCurrentTrackFromSession` so a stale
     *  speed-transcode poll loop (e.g. from a song that got skipped
     *  mid-transcode) bails out instead of issuing a stale `playUrl`.
     *  Mirrors `sendCurrentTrackGenRef` in the renderer engine.
     */
    private sendCurrentTrackGen = 0;
    /**
     *  True once the first `setQueue` RPC arrives — the server is now
     *  authoritative for queue + player state, and the renderer is a
     *  mirror.  Cleared on disconnect / passive disconnect.
     */
    private serverAuthoritative = false;
    // --- server-authoritative session (Phase D) ---
    /** Owns queue + player state when `isServerAuthoritative` is true. */
    private readonly session = new DlnaSessionState();

    private subscriptionRenewalTimeout: NodeJS.Timeout | null = null;
    private subscriptionSid: null | string = null;
    private readonly topologyHelpers: ReturnType<typeof createTopologyHelpers>;
    private topologyPollingInterval: NodeJS.Timeout | null = null;
    private topologyRefreshAttempt = 0;
    private topologyRenewalTimeout: NodeJS.Timeout | null = null;

    private topologySubscriptionSid: null | string = null;
    private trackLoadedAt = 0;
    private readonly transcoder: Transcoder;

    constructor(config: DlnaControllerConfig) {
        super();
        this.config = config;
        this.dlnaLog = (action: string, err?: unknown) => {
            config.logger.info(`[DLNA] ${action}`, err);
        };

        // Route the SOAP client's playerLog through our logger too —
        // this otherwise defaults to console.log.
        setSoapLogger((action, err) => config.logger.info(action, err));

        this.networkHelpers = createNetworkHelpers({ overrideLanIp: config.overrideLanIp });
        const { getLanIp, getLanIpForDevice } = this.networkHelpers;

        this.eventServer = new EventServer({
            callbacks: {
                onNotify: (body) => this.handleEventNotify(body),
                onTopology: (body) => this.handleTopologyNotify(body),
            },
            externalServer: config.eventServerHttp?.server,
            fixedPort: config.eventServerHttp?.port,
            logger: { info: this.dlnaLog },
        });

        this.transcoder = new Transcoder(
            { info: this.dlnaLog },
            {
                eventServer: this.eventServer,
                getConnectedDevice: () => this.connectedDevice,
                getLanIp,
                getLanIpForDevice,
                onFfmpegMissing: () =>
                    this.emit('rendererDlnaToast', {
                        message:
                            'DLNA playback speed changes require FFMpeg to be installed and added to PATH.',
                        type: 'error',
                    }),
            },
        );

        this.topologyHelpers = createTopologyHelpers({ info: this.dlnaLog });
    }

    // ------------------------------------------------------------------
    // ControllerLike — introspection
    // ------------------------------------------------------------------

    async addGroupMember(device: DlnaDevice): Promise<{ success: boolean }> {
        if (!this.connectedDevice) return { success: false };
        if (this.groupMembers.some((m) => m.id === device.id)) {
            this.dlnaLog(`${device.name} is already in the group`);
            return { success: true };
        }
        try {
            await joinGroup(device, this.connectedDevice);
            this.groupMembers.push(device);
            this.expectedGroupMemberCount = this.groupMembers.length;
            this.topologyRefreshAttempt = 0;
            this.scheduleTopologyVerification();
            try {
                this.groupMemberVolumes[device.id] = await getVolume(device);
            } catch {
                this.groupMemberVolumes[device.id] = 50;
            }
            this.dlnaLog(`Added ${device.name} to group`);
            this.sendGroupStateToRenderer();
            return { success: true };
        } catch (err) {
            this.dlnaLog(`Failed to add ${device.name} to group`, err);
            return { success: false };
        }
    }

    cancelSpeedFile(_data: Omit<SpeedFileData, 'offset'>): void {
        this.transcoder.stopCurrentTranscode();
    }

    // ------------------------------------------------------------------
    // ControllerLike — discovery & connection
    // ------------------------------------------------------------------

    async checkSpeedFile(data: Omit<SpeedFileData, 'offset'>): Promise<null | string> {
        return this.transcoder.checkSpeedFile(data);
    }

    clearNextUrl(): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        this.lastQueuedNextUri = '';
        this.lastClearNextAt = Date.now();
        (async () => {
            try {
                await clearNextAVTransportURI(device);
                this.dlnaLog('Cleared next track');
            } catch (err) {
                this.dlnaLog('Failed to clear next track', err);
            }
        })();
    }

    async connect(device: DlnaDevice): Promise<ConnectResult> {
        try {
            if (this.connectedDevice) {
                // Use passive disconnect when reconnecting: stop/pause
                // is unnecessary (the new SetAVTransportURI / Play command
                // will handle device state), and fullDisconnect's stop()
                // causes an audible interruption on Sonos groups that
                // takes several seconds to recover from.  Passive
                // disconnect still tears down subscriptions, polling,
                // and the event server without touching transport state.
                await this.passiveDisconnect();
            }
            const actualDevice = device.groupMembers?.find((m) => m.id === device.id) || device;
            this.connectedDevice = actualDevice;
            this.currentCoordinatorId = actualDevice.id;
            this.groupMembers = device.groupMembers ? [...device.groupMembers] : [actualDevice];
            this.groupMemberVolumes = {};
            this.lastKnownPosition = 0;
            this.hasStartedPlaying = false;
            this.trackLoadedAt = Date.now();
            this.lastKnownTransportState = '';
            this.lastKnownDeviceVolume = -1;
            this.lastCommandedUri = '';
            this.lastQueuedNextUri = '';
            this.startPositionPolling();
            this.startTopologyPolling();
            this.refreshTopology();
            if (!this.config.disableEventSubscription) {
                // Fire-and-forget: event subscriptions are best-effort and
                // must NOT block the connect response. On Sonos, SUBSCRIBE
                // can stall for 10+ seconds (especially on reconnect while
                // a prior subscription is being torn down); awaiting it
                // here caused the "Connecting..." spinner to hang for
                // 30-60+ seconds in the browser UI. Position polling and
                // the initial state fetch below still work without events.
                // Errors are already swallowed inside the subscribe methods.
                void this.startEventSubscription(device);
                void this.startTopologySubscription(device);
            }
            this.dlnaLog(`Connected to ${device.name}`);
            // Get current volume from device to sync UI
            let deviceVolume = 50;
            try {
                deviceVolume = await getVolume(device);
                this.lastKnownDeviceVolume = deviceVolume;
                this.groupMemberVolumes[device.id] = deviceVolume;
                this.dlnaLog(`Device volume: ${deviceVolume}`);
            } catch {
                // Use default
            }
            let currentUri = '';
            let nextUri = '';
            let currentPosition = 0;
            let currentDuration = 0;
            let currentTransportState = 'STOPPED';
            try {
                const [posInfo, tState, mediaInfo] = await Promise.all([
                    getPositionInfo(device),
                    getTransportInfo(device),
                    getMediaInfo(device).catch(() => ({ currentUri: '', nextUri: '' })),
                ]);
                currentTransportState = tState;
                this.lastKnownTransportState = currentTransportState || 'STOPPED';
                const isActive =
                    tState === 'PLAYING' ||
                    tState === 'PAUSED_PLAYBACK' ||
                    tState === 'TRANSITIONING';
                if (isActive && posInfo.trackUri && posInfo.trackUri !== 'NOT_IMPLEMENTED') {
                    currentUri = posInfo.trackUri;
                    currentPosition = posInfo.position;
                    currentDuration = posInfo.duration;
                    this.lastCommandedUri = currentUri;
                    nextUri = mediaInfo.nextUri || '';
                    if (nextUri) this.lastQueuedNextUri = nextUri;
                    this.dlnaLog(
                        `Device already playing: ${currentUri} at ${currentPosition}s (${tState})`,
                    );
                }
            } catch {
                // Catch
            }

            this.sendGroupStateToRenderer();
            if (currentUri && currentTransportState !== 'STOPPED') {
                this.emit('rendererDlnaConnectPlayback', {
                    duration: currentDuration,
                    nextUri,
                    position: currentPosition,
                    transportState: currentTransportState,
                    uri: currentUri,
                });
            }
            return {
                currentDuration,
                currentPosition,
                currentTransportState,
                currentUri,
                nextUri,
                success: true,
                volume: deviceVolume,
            };
        } catch (err) {
            this.dlnaLog(`Failed to connect to ${device.name}`, err);
            return {
                currentDuration: 0,
                currentPosition: 0,
                currentTransportState: 'STOPPED',
                currentUri: '',
                nextUri: '',
                success: false,
                volume: 50,
            };
        }
    }

    destroySpeedProxy(): void {
        this.transcoder.stopSpeedProxy();
        this.transcoder.stopCurrentTranscode();
    }

    // ------------------------------------------------------------------
    // ControllerLike — groups
    // ------------------------------------------------------------------

    async disconnect(): Promise<boolean> {
        try {
            await this.fullDisconnect();
            return true;
        } catch (err) {
            this.dlnaLog('Failed to disconnect', err);
            this.connectedDevice = null;
            this.groupMembers = [];
            this.groupMemberVolumes = {};
            this.isRadioMode = false;
            this.stopPositionPolling();
            return false;
        }
    }

    async disconnectPassive(): Promise<boolean> {
        try {
            await this.passiveDisconnect();
            return true;
        } catch (err) {
            this.dlnaLog('Failed to passive-disconnect', err);
            this.connectedDevice = null;
            this.groupMembers = [];
            this.groupMemberVolumes = {};
            this.isRadioMode = false;
            this.stopPositionPolling();
            return false;
        }
    }

    async discover(): Promise<DlnaDevice[]> {
        try {
            this.dlnaLog('Discovering devices...');
            // 3000ms is enough for Sonos and most DLNA devices — they
            // respond to M-SEARCH within 500ms. The M-SEARCH is sent at
            // 0/500/1500ms, and with MX:3 devices should respond by ~4.5s,
            // but in practice all devices respond well within 2s. This
            // cuts ~2s off the cast-button open time vs the previous 5000.
            const result = await discoverDevices(3000);
            this.dlnaLog(`Found ${result.length} device(s)`);
            const { enrichDevicesWithTopology } = this.topologyHelpers;
            const finalDevices = await enrichDevicesWithTopology(result);
            this.emit('rendererDlnaDiscoveryUpdate', finalDevices);
            return finalDevices;
        } catch (err) {
            this.dlnaLog('Discovery failed', err);
            return [];
        }
    }

    async getGroupState(): Promise<GroupMember[]> {
        if (!this.connectedDevice || this.groupMembers.length === 0) return [];
        return this.groupMembers.map((m) => ({
            device: m,
            isCoordinator:
                m.id === this.currentCoordinatorId ||
                (!this.currentCoordinatorId && m.id === this.connectedDevice?.id),
            volume: this.groupMemberVolumes[m.id] ?? 50,
        }));
    }

    /**
     *  Returns a cached snapshot of the currently-connected session's
     *  playback state, used by the WS transport to synchronise a newly
     *  connected client (e.g. a second browser tab opening while another
     *  tab is already casting).  No device queries are performed — this
     *  just reads the controller's last-known cached values and the
     *  already-built group state, so it is safe to call on every WS hello.
     *
     *  Position is converted to wall-clock (real) time if the current
     *  URI is a speed-transcoded file — the renderer's `setTimestamp`
     *  expects real-time seconds, and `lastKnownPosition` is in
     *  device-side (transcoded) time.
     */
    getPlaybackSnapshot(): {
        groupState: GroupMember[];
        playback: null | {
            duration: number;
            nextUri: string;
            position: number;
            transportState: string;
            uri: string;
        };
        volume: number;
    } {
        if (!this.connectedDevice) {
            return { groupState: [], playback: null, volume: 0 };
        }
        // Reuse the same shape as `rendererDlnaConnectPlayback` so the
        // renderer can process the snapshot through the existing handler.
        const proxyState = getActiveProxyState(this.lastCommandedUri);
        const realPosition = proxyState
            ? this.lastKnownPosition * proxyState.speed
            : this.lastKnownPosition;
        const realDuration = proxyState
            ? this.lastKnownDuration * proxyState.speed
            : this.lastKnownDuration;
        const playback =
            this.lastCommandedUri || this.lastKnownTransportState
                ? {
                      duration: realDuration,
                      nextUri: this.lastQueuedNextUri,
                      position: realPosition,
                      transportState: this.lastKnownTransportState,
                      uri: this.lastCommandedUri,
                  }
                : null;
        // Inlined from `getGroupState()` so this stays fully synchronous.
        const groupState: GroupMember[] =
            this.groupMembers.length === 0
                ? []
                : this.groupMembers.map((m) => ({
                      device: m,
                      isCoordinator:
                          m.id === this.currentCoordinatorId ||
                          (!this.currentCoordinatorId && m.id === this.connectedDevice?.id),
                      volume: this.groupMemberVolumes[m.id] ?? 50,
                  }));
        return {
            groupState,
            playback,
            volume: Math.max(0, this.lastKnownDeviceVolume),
        };
    }

    async getPosition(): Promise<number> {
        if (!this.connectedDevice) return 0;
        try {
            const info = await getPositionInfo(this.connectedDevice);
            const proxyState = getActiveProxyState(this.lastCommandedUri);
            return proxyState ? info.position * proxyState.speed : info.position;
        } catch {
            return this.lastKnownPosition;
        }
    }

    // ------------------------------------------------------------------
    // ControllerLike — speaker properties
    // ------------------------------------------------------------------

    getQueueState(): { player: CastPlayerState; queue: CastQueueSnapshot } {
        return this.session.snapshot();
    }

    async getSpeakerProperties(deviceId: string): Promise<null | SpeakerProperties> {
        const device = this.groupMembers.find((m) => m.id === deviceId);
        if (!device) return null;
        try {
            const [bass, treble, loudness, crossfade, ledState, touchControls] = await Promise.all([
                getBass(device).catch(() => 0),
                getTreble(device).catch(() => 0),
                getLoudness(device).catch(() => false),
                getCrossfadeMode(device).catch(() => false),
                getLEDState(device).catch(() => true),
                getButtonLockState(device).catch(() => true),
            ]);
            this.dlnaLog(`Got properties for ${device.name}`);
            return { bass, crossfade, ledState, loudness, touchControls, treble };
        } catch (err) {
            this.dlnaLog(`Failed to get properties for ${device.name}`, err);
            return null;
        }
    }

    // ------------------------------------------------------------------
    // ControllerLike — speed transcoding
    // ------------------------------------------------------------------

    hasFfmpeg(): boolean {
        return this.transcoder.hasFfmpeg();
    }

    isConnected(): boolean {
        return this.connectedDevice !== null;
    }

    isServerAuthoritative(): boolean {
        return this.serverAuthoritative;
    }

    mute(muted: boolean): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                await setMute(device, muted);
            } catch (err) {
                this.dlnaLog(`Failed to set mute to ${muted}`, err);
            }
        })();
    }

    // ------------------------------------------------------------------
    // ControllerLike — playback commands
    // ------------------------------------------------------------------

    pause(): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                this.isPausedIntentionally = true;
                this.lastPauseCommandAt = Date.now();
                this.lastKnownTransportState = 'PAUSED_PLAYBACK';
                if (this.isRadioMode) {
                    this.lastCommandedUri = '';
                    this.lastQueuedNextUri = '';
                    await stop(device);
                    return;
                }
                await pause(device);
            } catch (err: any) {
                this.dlnaLog('Failed to pause', err);
                if (err?.message?.includes('701') || err?.message?.includes('500')) {
                    setTimeout(() => {
                        if (this.isPausedIntentionally) pause(device).catch(() => {});
                    }, 1500);
                }
            }
        })();
    }

    play(): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                this.isPausedIntentionally = false;
                this.trackLoadedAt = Date.now();
                this.lastPlayCommandAt = Date.now();
                this.lastPauseCommandAt = 0;
                this.lastKnownTransportState = 'PLAYING';
                await play(device);
            } catch (err) {
                this.dlnaLog('Failed to resume playback', err);
            }
        })();
    }

    playUrl(
        url: string,
        metadata: TrackMetadata,
        opts?: { isMuted?: boolean; seekTo?: number },
    ): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        const data = {
            isMuted: opts?.isMuted,
            metadata,
            seekTo: opts?.seekTo,
            url,
        };
        this.runPlayUrl(device, data);
    }

    async prepareSpeedFile(data: SpeedFileData): Promise<null | string> {
        return this.transcoder.prepareSpeedFile(data);
    }

    async queueAdd(
        songs: CastQueueSong[],
        playType: Play,
        playSongId?: string,
    ): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        const result = this.session.add(songs, playType, playSongId);
        // Structural queue change → full snapshot broadcast.
        this.broadcastQueueState();
        if (result.changed && result.song) {
            await this.sendCurrentTrackFromSession();
        } else if (result.song) {
            // Song added but current didn't change — refresh gapless
            // pre-load for the (possibly different) next track.
            this.preloadNextTrackFromSession();
        }
        return { ok: true };
    }

    async queueClear(): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.clear();
        this.broadcastQueueState();
        this.stop();
        return { ok: true };
    }

    async queueMove(
        uniqueIds: string[],
        targetUniqueId: string,
        edge: 'bottom' | 'top',
    ): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.move(uniqueIds, targetUniqueId, edge);
        this.broadcastQueueState();
        // Index in the playback order may have shifted; refresh gapless
        // pre-load.
        this.preloadNextTrackFromSession();
        return { ok: true };
    }

    async queueRemove(uniqueIds: string[]): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.remove(uniqueIds);
        this.broadcastQueueState();
        // If the current song was among the removed, the session picked
        // a new one (or stopped) — issue playUrl for the new current.
        const current = this.session.getCurrentSong();
        if (current) {
            await this.sendCurrentTrackFromSession();
        } else {
            // Queue empty → stop device
            this.stop();
        }
        return { ok: true };
    }

    async queueShuffleAll(): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.shuffleAll();
        this.broadcastQueueState();
        // Index 0 in the new shuffle — issue playUrl if the current song
        // changed.  The session preserves the current song at index 0,
        // so it usually doesn't change, but re-issue playUrl just in
        // case the device's transport state needs nudging.
        return { ok: true };
    }

    async removeGroupMember(deviceId: string): Promise<{ success: boolean }> {
        if (!this.connectedDevice || deviceId === this.connectedDevice.id)
            return { success: false };
        const device = this.groupMembers.find((m) => m.id === deviceId);
        if (!device) return { success: false };
        try {
            try {
                await stop(device);
            } catch {
                // Catch
            }
            await becomeCoordinatorOfStandaloneGroup(device);
            this.groupMembers = this.groupMembers.filter((m) => m.id !== deviceId);
            this.expectedGroupMemberCount = this.groupMembers.length;
            this.topologyRefreshAttempt = 0;
            this.scheduleTopologyVerification();
            if (this.groupMembers.length === 1 && this.connectedDevice) {
                this.currentCoordinatorId = this.connectedDevice.id;
            }
            delete this.groupMemberVolumes[deviceId];
            this.dlnaLog(`Removed ${device.name} from group`);
            this.sendGroupStateToRenderer();
            return { success: true };
        } catch (err) {
            this.dlnaLog(`Failed to remove ${device.name} from group`, err);
            return { success: false };
        }
    }

    seek(seconds: number): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                this.lastAppSeekAt = Date.now();
                let targetSeconds = seconds;
                const proxyState = getActiveProxyState(this.lastCommandedUri);
                if (proxyState) {
                    targetSeconds = seconds / proxyState.speed;
                }
                await seek(device, targetSeconds);
            } catch (err) {
                this.dlnaLog(`Failed to seek to ${seconds}`, err);
            }
        })();
    }

    // ------------------------------------------------------------------
    // ControllerLike — server-authoritative session RPCs (Phase D)
    // ------------------------------------------------------------------

    async sessionNext(toNextAlbum?: boolean): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        const result = this.session.next(toNextAlbum);
        if (result.shouldStop) {
            this.stop();
            this.broadcastPlayerState();
            return { ok: true };
        }
        if (result.changed && result.song) {
            await this.sendCurrentTrackFromSession();
        }
        // Player field patch (index/status/seekTo) — broadcast partial.
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionPlayByIndex(index: number): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        const result = this.session.playByIndex(index);
        if (result.changed && result.song) {
            await this.sendCurrentTrackFromSession();
        }
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionPlayByUniqueId(uniqueId: string): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        const result = this.session.playByUniqueId(uniqueId);
        if (result.changed && result.song) {
            await this.sendCurrentTrackFromSession();
        }
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionPrevious(toPreviousAlbum?: boolean): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        const result = this.session.previous(toPreviousAlbum);
        if (result.changed && result.song) {
            await this.sendCurrentTrackFromSession();
        }
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSeek(seconds: number): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.seek(seconds);
        this.seek(seconds);
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSetMuted(muted: boolean): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setMuted(muted);
        this.mute(muted);
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSetRepeat(repeat: PlayerRepeat): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setRepeat(repeat);
        // Refresh gapless pre-load since repeat affects the "next" track.
        this.preloadNextTrackFromSession();
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSetShuffle(shuffle: PlayerShuffle): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setShuffle(shuffle);
        // Toggling shuffle renumbers the playback order — send the full
        // snapshot so all tabs see the new order, plus the new current
        // index (session preserves the current song, but its position
        // in the playback order may have changed).
        this.broadcastQueueState();
        this.preloadNextTrackFromSession();
        return { ok: true };
    }

    async sessionSetSpeed(speed: number): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setSpeed(speed);
        // Speed ≠ 1 requires re-issuing playUrl with a transcoded file.
        // The transcode loop is in `sendCurrentTrackFromSession`.
        await this.sendCurrentTrackFromSession();
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSetStatus(status: PlayerStatus): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setStatus(status);
        // Map to device command.
        if (status === PlayerStatus.PLAYING) this.play();
        else if (status === PlayerStatus.PAUSED) this.pause();
        else if (status === PlayerStatus.STOPPED) this.stop();
        this.broadcastPlayerState();
        return { ok: true };
    }

    async sessionSetVolume(volume: number): Promise<{ ok: boolean }> {
        if (!this.serverAuthoritative) return { ok: false };
        this.session.setVolume(volume);
        // Push to device (existing `volume()` method handles SOAP).
        this.volume(volume);
        this.broadcastPlayerState();
        return { ok: true };
    }

    setGroupMemberMute(deviceId: string, muted: boolean): void {
        const device = this.groupMembers.find((m) => m.id === deviceId);
        if (!device) return;
        (async () => {
            try {
                await setMute(device, muted);
            } catch (err) {
                this.dlnaLog(`Failed to set mute on ${device.name}`, err);
            }
        })();
    }

    setGroupMemberVolume(deviceId: string, volume: number): void {
        const device = this.groupMembers.find((m) => m.id === deviceId);
        if (!device) return;
        (async () => {
            try {
                await setVolume(device, volume);
                this.groupMemberVolumes[deviceId] = volume;
            } catch (err) {
                this.dlnaLog(`Failed to set volume on ${device.name}`, err);
            }
        })();
    }

    setNextUrl(url: string, metadata: TrackMetadata): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                if (!url) {
                    this.lastQueuedNextUri = '';
                    try {
                        await clearNextAVTransportURI(device);
                    } catch {
                        // Pass
                    }
                    this.dlnaLog('Cleared next track');
                    return;
                }
                const lanUrl = this.networkHelpers.rewriteUrlForLan(url);
                this.lastQueuedNextUri = lanUrl;
                const lanArtUrl = metadata?.albumArtUrl
                    ? this.networkHelpers.rewriteUrlForLan(metadata.albumArtUrl)
                    : undefined;
                await setNextAVTransportURI(device, lanUrl, {
                    ...metadata,
                    albumArtUrl: lanArtUrl,
                });
                this.dlnaLog(`Set next track: ${metadata.title}`);
            } catch (err) {
                this.dlnaLog(`Failed to set next track ${metadata?.title || ''}`, err);
            }
        })();
    }

    async setQueue(
        queue: CastQueueSnapshot,
        playerState?: Partial<CastPlayerState>,
    ): Promise<{ ok: boolean }> {
        if (!this.connectedDevice) return { ok: false };
        this.serverAuthoritative = true;
        this.session.setQueue(queue, playerState);
        // Broadcast the full snapshot first so all tabs (including the
        // initiator) see the queue.  The initiator's local store already
        // has this state, but applying the broadcast is idempotent because
        // `applyingRemoteUpdate` is set during the RPC call path in the
        // renderer (see Phase E).
        this.broadcastQueueState();
        // Issue playUrl for the new current track (if any).
        const current = this.session.getCurrentSong();
        if (current) {
            await this.sendCurrentTrackFromSession();
        }
        return { ok: true };
    }

    setRadioMode(enabled: boolean): void {
        this.isRadioMode = enabled;
        this.dlnaLog(`Radio mode ${enabled ? 'enabled' : 'disabled'}`);
        if (enabled) {
            this.pendingPrevTrack = false;
            this.hasStartedPlaying = false;
            this.lastKnownPosition = 0;
            this.lastCommandedUri = '';
            this.lastQueuedNextUri = '';
        }
    }

    setSpeakerProperty(
        deviceId: string,
        property: keyof SpeakerProperties,
        value: boolean | number,
    ): void {
        const device = this.groupMembers.find((m) => m.id === deviceId);
        if (!device) return;
        (async () => {
            try {
                switch (property) {
                    case 'bass':
                        await setBass(device, value as number);
                        break;
                    case 'crossfade':
                        await setCrossfadeMode(device, value as boolean);
                        break;
                    case 'ledState':
                        await setLEDState(device, value as boolean);
                        break;
                    case 'loudness':
                        await setLoudness(device, value as boolean);
                        break;
                    case 'touchControls':
                        await setButtonLockState(device, value as boolean);
                        break;
                    case 'treble':
                        await setTreble(device, value as number);
                        break;
                }
                this.dlnaLog(`Set ${property}=${value} on ${device.name}`);
            } catch (err) {
                this.dlnaLog(`Failed to set ${property} on ${device.name}`, err);
            }
        })();
    }

    stop(): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                this.isPausedIntentionally = true;
                this.lastCommandedUri = '';
                this.lastQueuedNextUri = '';
                await stop(device);
            } catch (err) {
                this.dlnaLog('Failed to stop', err);
            }
        })();
    }

    volume(value: number): void {
        if (!this.connectedDevice) return;
        const device = this.connectedDevice;
        (async () => {
            try {
                await setVolume(device, value);
                this.lastKnownDeviceVolume = value;
                if (this.groupMembers.length > 0) this.groupMemberVolumes[device.id] = value;
            } catch (err) {
                this.dlnaLog(`Failed to set volume to ${value}`, err);
            }
        })();
    }

    /** Broadcast a partial player-state patch (index/status/vol/etc).
     *  Called for non-structural changes (next/prev/setRepeat/etc). */
    private broadcastPlayerState(): void {
        if (!this.serverAuthoritative) return;
        this.emit('rendererPlayerState', this.session.playerPatch());
    }

    /** Broadcast the full queue + player snapshot.  Called on structural
     *  queue changes (setQueue, queueAdd, queueRemove, queueMove,
     *  queueShuffleAll, queueClear). */
    private broadcastQueueState(): void {
        if (!this.serverAuthoritative) return;
        this.emit('rendererQueueState', this.session.snapshot());
    }

    private async fullDisconnect(): Promise<void> {
        this.stopPositionPolling();
        this.hasStartedPlaying = false;
        this.lastCommandedUri = '';
        this.lastQueuedNextUri = '';
        this.lastKnownDuration = 0;
        this.nearEndStallCount = 0;
        this.isRadioMode = false;
        this.serverAuthoritative = false;
        this.session.reset();
        if (this.connectedDevice) {
            try {
                await stop(this.connectedDevice);
            } catch {
                // Catch
            }
            await this.stopEventSubscription(this.connectedDevice);
            await this.stopTopologySubscription(this.connectedDevice);
            this.dlnaLog(`Disconnected from ${this.connectedDevice.name}`);
        }
        this.connectedDevice = null;
        this.currentCoordinatorId = '';
        this.groupMembers = [];
        this.groupMemberVolumes = {};
        this.expectedGroupMemberCount = -1;
        this.topologyRefreshAttempt = 0;
        if (this.pendingTopologyRefreshTimeout) {
            clearTimeout(this.pendingTopologyRefreshTimeout);
            this.pendingTopologyRefreshTimeout = null;
        }
        if (this.topologyPollingInterval) {
            clearInterval(this.topologyPollingInterval);
            this.topologyPollingInterval = null;
        }
        this.sendGroupStateToRenderer();
        await this.eventServer.stop();
        this.transcoder.stopCurrentTranscode();
        this.transcoder.cleanupTempFiles();
    }

    private getEventUrl(device: DlnaDevice): string {
        return device.controlUrl.replace(/\/Control$/, '/Event');
    }

    /**
     *  Device-originated "previous track" handler.  Symmetric to
     *  `handleDeviceTrackEnded`: when the server is authoritative,
     *  call `session.previous()` and re-issue `playUrl`; else emit
     *  `rendererDlnaPrevTrack` for the renderer to handle.
     */
    private handleDevicePrevTrack(): void {
        if (this.serverAuthoritative) {
            const result = this.session.previous(false);
            if (result.changed) {
                void this.sendCurrentTrackFromSession();
            }
            this.broadcastPlayerState();
        } else {
            this.emit('rendererDlnaPrevTrack');
        }
    }

    /**
     *  Device-originated track-end handler.  When the server is
     *  authoritative, the session advances on the server side and we
     *  issue `playUrl` for the new current song (the renderer is just
     *  a mirror and does not round-trip `playUrl` back).  When NOT
     *  authoritative (legacy Electron IPC path, or DLNA mode before
     *  the renderer has sent its first `setQueue` RPC), keep the
     *  legacy behavior: emit `rendererDlnaTrackEnded` and let the
     *  renderer's `mediaAutoNext` handler drive the next track.
     *
     *  Always emits `rendererDlnaTrackEnded` even in server-
     *  authoritative mode — the renderer uses it for UI animation
     *  cues (e.g. transitioning the album-art crossfade), and the
     *  Phase E `isDlnaMode` guard prevents the renderer from
     *  advancing its own queue on that signal.
     */
    private handleDeviceTrackEnded(opts: { gapless: boolean }): void {
        this.emit('rendererDlnaTrackEnded', { gapless: opts.gapless });
        if (this.serverAuthoritative) {
            const result = this.session.next(false);
            if (result.shouldStop) {
                this.stop();
                this.broadcastPlayerState();
                return;
            }
            // When the device gaplessly advanced on its own ( Sonos
            // cross-faded from track N to the pre-loaded track N+1 via
            // `setNextAVTransportURI`), the device is ALREADY playing the
            // new current song by the time we detect the URI change.
            // Calling `sendCurrentTrackFromSession` here would re-issue
            // `SetAVTransportURI` for the same URL, hit the "URI already
            // loaded" branch in `runPlayUrl`, and `seek(0)+play` — which
            // restarts the track from the beginning (audible stutter
            // ~0.5s after the gapless advance).
            //
            // For the non-gapless case (device STOPPED at end-of-track or
            // stuck-at-end stall), the device is NOT playing the new track
            // — we must issue `playUrl` to load it.
            if (result.changed && !opts.gapless) {
                void this.sendCurrentTrackFromSession();
            } else if (result.changed && opts.gapless) {
                // Device already moved to the next URI.  Refresh the
                // gapless pre-load for the (new) next track so the
                // device can seamlessly advance again.  `resetPosition`
                // is implicit: the device is already at position 0 of
                // the new track, and the polling loop will pick that up.
                this.broadcastPlayerState();
                setTimeout(() => this.preloadNextTrackFromSession(), 1000);
            } else {
                this.broadcastPlayerState();
            }
        }
    }

    private handleEventNotify(body: string): void {
        if (this.isRadioMode) return;
        const lastChangeMatch = body.match(/<LastChange>([\s\S]*?)<\/LastChange>/);
        if (!lastChangeMatch) return;
        const innerXml = lastChangeMatch[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"');
        const uriMatch = innerXml.match(/<AVTransportURI[^>]+\bval="([^"]*)"/);
        if (!uriMatch) return;
        const newUri = uriMatch[1]
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"');
        if (!newUri || newUri === this.lastCommandedUri) {
            if (
                this.lastQueuedNextUri &&
                newUri === this.lastQueuedNextUri &&
                this.lastQueuedNextUri !== this.lastCommandedUri
            ) {
                this.dlnaLog('Gapless transition detected (event)');
                this.lastCommandedUri = newUri;
                this.lastQueuedNextUri = '';
                this.hasStartedPlaying = true;
                this.trackLoadedAt = Date.now();
                this.lastKnownPosition = 0;
                this.handleDeviceTrackEnded({ gapless: true });
            }
            return;
        }
        if (!this.lastCommandedUri) return;
        if (this.lastQueuedNextUri && newUri === this.lastQueuedNextUri) {
            this.dlnaLog('Event: advanced to next track');
            this.lastCommandedUri = newUri;
            this.lastQueuedNextUri = '';
            this.hasStartedPlaying = true;
            this.trackLoadedAt = Date.now();
            this.lastKnownPosition = 0;
            this.handleDeviceTrackEnded({ gapless: true });
        } else {
            this.dlnaLog('Event: URI is now unknown');
        }
    }

    // ------------------------------------------------------------------
    // Internal: disconnect paths
    // ------------------------------------------------------------------

    private handleTopologyNotify(xml: string): void {
        try {
            const match = xml.match(/<ZoneGroupState>([\s\S]*?)<\/ZoneGroupState>/);
            if (!match) return;
            const decodedXml = match[1]
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&');
            if (!this.connectedDevice) return;
            if (this.connectedDevice.isPair) return;
            const myRinconId = getRinconId(this.connectedDevice);
            const zoneGroupRegex = /<ZoneGroup\b[^>]*>[\s\S]*?<\/ZoneGroup>/g;
            const zoneGroups = decodedXml.match(zoneGroupRegex);
            if (!zoneGroups) return;
            const { getAttr } = this.topologyHelpers;
            const newMembers: DlnaDevice[] = [];
            let newCoordinatorRincon = '';
            for (const group of zoneGroups) {
                if (!group.includes(myRinconId)) continue;
                const groupTagMatch = group.match(/^<ZoneGroup\b([^>]*)>/);
                if (groupTagMatch) {
                    newCoordinatorRincon = getAttr(groupTagMatch[1], 'Coordinator');
                }
                const memberTagRegex = /<ZoneGroupMember\b([^>]*)\/?>/g;
                let tagMatch: null | RegExpExecArray;
                while ((tagMatch = memberTagRegex.exec(group)) !== null) {
                    const attrs = tagMatch[1];
                    const uuid = getAttr(attrs, 'UUID');
                    const location = getAttr(attrs, 'Location');
                    const zoneName = getAttr(attrs, 'ZoneName');
                    if (!uuid || !location) continue;
                    const existingMember = this.groupMembers.find((m) => m.id === `uuid:${uuid}`);
                    const finalName = existingMember ? existingMember.name : zoneName || uuid;
                    try {
                        const base = new URL(location);
                        const baseUrl = `${base.protocol}//${base.hostname}:1400`;
                        newMembers.push({
                            controlUrl: `${baseUrl}/MediaRenderer/AVTransport/Control`,
                            id: `uuid:${uuid}`,
                            location,
                            name: finalName,
                            renderingControlUrl: `${baseUrl}/MediaRenderer/RenderingControl/Control`,
                        });
                        if (!existingMember) {
                            fetchXml(location)
                                .then((descXml) => {
                                    const modelMatch = descXml.match(
                                        /<modelName>(.*?)<\/modelName>/,
                                    );
                                    if (modelMatch && modelMatch[1]) {
                                        const formattedName = `${zoneName} (${modelMatch[1]})`;
                                        const idx = this.groupMembers.findIndex(
                                            (m) => m.id === `uuid:${uuid}`,
                                        );
                                        if (
                                            idx !== -1 &&
                                            this.groupMembers[idx].name !== formattedName
                                        ) {
                                            this.groupMembers[idx].name = formattedName;
                                            this.sendGroupStateToRenderer();
                                        }
                                    }
                                })
                                .catch(() => {});
                        }
                    } catch {
                        // Skip members with unparseable locations
                    }
                }
                break;
            }
            const incomingSize = Math.max(newMembers.length, 1);
            if (
                this.expectedGroupMemberCount >= 0 &&
                incomingSize !== this.expectedGroupMemberCount
            ) {
                if (this.topologyRefreshAttempt < 10) {
                    this.scheduleTopologyVerification();
                } else {
                    this.expectedGroupMemberCount = -1;
                    this.topologyRefreshAttempt = 0;
                }
                return;
            }
            if (
                this.expectedGroupMemberCount >= 0 &&
                incomingSize === this.expectedGroupMemberCount
            ) {
                this.expectedGroupMemberCount = -1;
                this.topologyRefreshAttempt = 0;
                if (this.pendingTopologyRefreshTimeout) {
                    clearTimeout(this.pendingTopologyRefreshTimeout);
                    this.pendingTopologyRefreshTimeout = null;
                }
            }
            let newCoordinatorId = newCoordinatorRincon ? `uuid:${newCoordinatorRincon}` : '';
            if (newMembers.length <= 1 && this.connectedDevice) {
                const solo = newMembers.length === 1 ? newMembers[0] : this.connectedDevice;
                newCoordinatorId = this.connectedDevice.id;
                const hasTopologyChanged =
                    this.groupMembers.length !== 1 ||
                    this.groupMembers[0]?.id !== solo.id ||
                    this.currentCoordinatorId !== newCoordinatorId;
                if (hasTopologyChanged) {
                    this.groupMembers = [solo];
                    this.currentCoordinatorId = newCoordinatorId;
                    this.dlnaLog(`Topology Change Detected: Group size is now 1 (solo)`);
                    this.sendGroupStateToRenderer();
                }
                return;
            }
            const hasTopologyChanged =
                newMembers.length !== this.groupMembers.length ||
                newCoordinatorId !== this.currentCoordinatorId ||
                newMembers.some((m, i) => m.id !== this.groupMembers[i]?.id);
            if (hasTopologyChanged) {
                this.groupMembers = newMembers;
                this.currentCoordinatorId = newCoordinatorId;
                this.dlnaLog(
                    `Topology Change Detected: Group size is now ${this.groupMembers.length}`,
                );
                this.sendGroupStateToRenderer();
            }
        } catch (error) {
            this.dlnaLog('Topology parse error', error);
        }
    }

    private async passiveDisconnect(): Promise<void> {
        this.stopPositionPolling();
        this.hasStartedPlaying = false;
        this.lastCommandedUri = '';
        this.lastQueuedNextUri = '';
        this.lastKnownDuration = 0;
        this.nearEndStallCount = 0;
        this.isRadioMode = false;
        this.serverAuthoritative = false;
        this.session.reset();
        if (this.connectedDevice) {
            await this.stopEventSubscription(this.connectedDevice);
            await this.stopTopologySubscription(this.connectedDevice);
            this.dlnaLog(
                `Passive disconnect from ${this.connectedDevice.name} (speaker keeps playing)`,
            );
        }
        this.connectedDevice = null;
        this.currentCoordinatorId = '';
        this.groupMembers = [];
        this.groupMemberVolumes = {};
        this.expectedGroupMemberCount = -1;
        this.topologyRefreshAttempt = 0;
        if (this.pendingTopologyRefreshTimeout) {
            clearTimeout(this.pendingTopologyRefreshTimeout);
            this.pendingTopologyRefreshTimeout = null;
        }
        if (this.topologyPollingInterval) {
            clearInterval(this.topologyPollingInterval);
            this.topologyPollingInterval = null;
        }
        this.sendGroupStateToRenderer();
        await this.eventServer.stop();
        this.transcoder.stopCurrentTranscode();
        this.transcoder.cleanupTempFiles();
    }

    // ------------------------------------------------------------------
    // Internal: event subscription (AVTransport + ZoneGroupTopology)
    // ------------------------------------------------------------------

    /**
     *  Pre-load the next track on the device via `setNextUrl` for
     *  gapless playback.  Mirrors the renderer's `sendNextTrackToDlna`
     *  debounce-and-send pattern (but synchronous here since there's
     *  no React store subscription to debounce against).
     */
    private preloadNextTrackFromSession(): void {
        if (!this.connectedDevice) return;
        const next = this.session.peekNextSong();
        if (!next || !next.resolvedStreamUrl) {
            this.clearNextUrl();
            return;
        }
        const metadata: TrackMetadata = {
            albumArtUrl: next.resolvedAlbumArtUrl,
            albumName: next.album || undefined,
            artistName: next.artistName || next.artists?.[0]?.name || undefined,
            duration: next.duration ? next.duration / 1000 : undefined,
            mimeType: next.resolvedMimeType,
            title: next.name,
        };
        this.setNextUrl(next.resolvedStreamUrl, metadata);
    }

    private refreshTopology(): void {
        if (!this.connectedDevice) return;
        try {
            const parsedUrl = new URL(this.connectedDevice.controlUrl);
            const controlUrl = `http://${parsedUrl.hostname}:1400/ZoneGroupTopology/Control`;
            const body = `<?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                <s:Body>
                    <u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState>
                </s:Body>
            </s:Envelope>`;
            const req = http.request(
                controlUrl,
                {
                    headers: {
                        Connection: 'close',
                        'Content-Length': Buffer.byteLength(body, 'utf8'),
                        'Content-Type': 'text/xml; charset="utf-8"',
                        SOAPAction:
                            '"urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"',
                    },
                    method: 'POST',
                },
                (res) => {
                    let data = '';
                    res.on('data', (chunk) => (data += chunk));
                    res.on('end', () => {
                        if (data.includes('GetZoneGroupStateResponse')) {
                            this.handleTopologyNotify(data);
                        }
                    });
                },
            );
            req.on('error', () => {});
            req.write(body);
            req.end();
        } catch {
            // Catch
        }
    }

    private async renewEventSubscription(device: DlnaDevice): Promise<void> {
        if (!this.subscriptionSid) return;
        try {
            const parsedUrl = new URL(this.getEventUrl(device));
            await new Promise<void>((resolve, reject) => {
                const req = http.request(
                    {
                        headers: { SID: this.subscriptionSid!, TIMEOUT: 'Second-1800' },
                        hostname: parsedUrl.hostname,
                        method: 'SUBSCRIBE',
                        path: parsedUrl.pathname,
                        port: parsedUrl.port || '1400',
                    },
                    (res) => {
                        res.resume();
                        resolve();
                    },
                );
                req.on('error', reject);
                req.setTimeout(5000, () => req.destroy(new Error('Renewal timed out')));
                req.end();
            });
            this.dlnaLog('Renewed AVTransport event subscription');
            this.subscriptionRenewalTimeout = setTimeout(
                () => this.renewEventSubscription(device),
                25 * 60 * 1000,
            );
        } catch (err) {
            this.dlnaLog('Failed to renew event subscription', err);
        }
    }

    private async renewTopologySubscription(device: DlnaDevice): Promise<void> {
        if (!this.topologySubscriptionSid) return;
        try {
            const parsedUrl = new URL(getTopologyEventUrl(device));
            await new Promise<void>((resolve, reject) => {
                const req = http.request(
                    {
                        headers: { SID: this.topologySubscriptionSid!, TIMEOUT: 'Second-1800' },
                        hostname: parsedUrl.hostname,
                        method: 'SUBSCRIBE',
                        path: parsedUrl.pathname,
                        port: parsedUrl.port || '1400',
                    },
                    (res) => {
                        res.resume();
                        resolve();
                    },
                );
                req.on('error', reject);
                req.setTimeout(5000, () => req.destroy(new Error('Topology renewal timed out')));
                req.end();
            });
            this.dlnaLog('Renewed ZoneGroupTopology subscription');
            this.topologyRenewalTimeout = setTimeout(
                () => this.renewTopologySubscription(device),
                25 * 60 * 1000,
            );
        } catch (err) {
            this.dlnaLog('Failed to renew topology subscription', err);
        }
    }

    private async runPlayUrl(
        device: DlnaDevice,
        data: { isMuted?: boolean; metadata: TrackMetadata; seekTo?: number; url: string },
    ): Promise<void> {
        try {
            this.hasStartedPlaying = false;
            this.lastKnownPosition = 0;
            this.isPausedIntentionally = data.metadata.autoPlay === false;
            this.lastAppSeekAt = Date.now();
            this.lastKnownDuration = 0;
            this.nearEndStallCount = 0;
            const lanUrl = this.networkHelpers.rewriteUrlForLan(data.url);
            this.lastPlayCommandAt = Date.now();
            if (lanUrl === this.lastCommandedUri && !data.seekTo) {
                this.dlnaLog(
                    `dlna-play-url: URI already loaded (${data.metadata.title}), seeking to 0 and playing`,
                );
                this.lastQueuedNextUri = '';
                if (data.metadata.autoPlay !== false) {
                    try {
                        await seek(device, 0);
                    } catch {
                        // seek may fail on some devices; proceed to play anyway
                    }
                    await play(device).catch((err) =>
                        this.dlnaLog('Play (skip-reload) failed', err),
                    );
                }
                return;
            }
            this.trackLoadedAt = Date.now();
            this.lastPlayUrlSentAt = Date.now();
            this.lastLoadedFromUri = this.lastCommandedUri;
            this.lastCommandedUri = lanUrl;
            this.lastQueuedNextUri = '';
            const lanArtUrl = data.metadata.albumArtUrl
                ? this.networkHelpers.rewriteUrlForLan(data.metadata.albumArtUrl)
                : undefined;
            const metadata = { ...data.metadata, albumArtUrl: lanArtUrl };
            const shouldMuteTrick = data.seekTo !== undefined && data.seekTo > 0;
            if (shouldMuteTrick) {
                try {
                    await setMute(device, true);
                    await Promise.all(
                        this.groupMembers.map((m) => setMute(m, true).catch(() => {})),
                    );
                } catch {
                    // Pass
                }
            }
            await setAVTransportURI(device, lanUrl, metadata);
            await new Promise((r) => setTimeout(r, 1000));
            if (data.metadata.autoPlay !== false) {
                await play(device).catch((err) => this.dlnaLog('Initial play failed', err));
                this.dlnaLog(`Playing: ${data.metadata.title}`);
                if (shouldMuteTrick) {
                    await this.waitForTransportState(device, ['PLAYING'], 4000);
                    await new Promise((r) => setTimeout(r, 1200));
                    let targetSeek = data.seekTo!;
                    const proxyState = getActiveProxyState(lanUrl);
                    this.dlnaLog(
                        `mute-trick seek: data.seekTo=${data.seekTo} lanUrl=${lanUrl} proxyState=${JSON.stringify(proxyState)} targetSeek=${proxyState ? targetSeek / proxyState.speed : targetSeek}`,
                    );
                    if (proxyState) {
                        targetSeek = targetSeek / proxyState.speed;
                    }
                    for (let i = 0; i < 3; i++) {
                        try {
                            await seek(device, targetSeek);
                            break;
                        } catch (err: any) {
                            if (err?.message?.includes('701') || err?.message?.includes('500')) {
                                this.dlnaLog(`Seek failed (701), retrying... (${i + 1}/3)`);
                                await new Promise((r) => setTimeout(r, 1000));
                            } else {
                                break;
                            }
                        }
                    }
                    await setMute(device, !!data.isMuted).catch(() => {});
                    await Promise.all(
                        this.groupMembers.map((m) => setMute(m, !!data.isMuted).catch(() => {})),
                    );
                }
            } else {
                this.dlnaLog(`Queued (Paused): ${data.metadata.title}`);
                if (shouldMuteTrick) {
                    await play(device).catch(() => {});
                    await this.waitForTransportState(device, ['PLAYING'], 4000);
                    await new Promise((r) => setTimeout(r, 1200));
                    let targetSeek = data.seekTo!;
                    const proxyState = getActiveProxyState(lanUrl);
                    if (proxyState) targetSeek = targetSeek / proxyState.speed;
                    for (let i = 0; i < 3; i++) {
                        try {
                            await seek(device, targetSeek);
                            break;
                        } catch (err: any) {
                            if (err?.message?.includes('701') || err?.message?.includes('500')) {
                                this.dlnaLog(`Seek failed (701), retrying... (${i + 1}/3)`);
                                await new Promise((r) => setTimeout(r, 1000));
                            } else {
                                break;
                            }
                        }
                    }
                    await pause(device).catch(() => {});
                    await setMute(device, !!data.isMuted).catch(() => {});
                    await Promise.all(
                        this.groupMembers.map((m) => setMute(m, !!data.isMuted).catch(() => {})),
                    );
                }
            }
        } catch {
            if (data.seekTo !== undefined) {
                await setMute(device, !!data.isMuted).catch(() => {});
                await Promise.all(
                    this.groupMembers.map((m) => setMute(m, !!data.isMuted).catch(() => {})),
                );
            }
        }
    }

    private scheduleTopologyVerification(): void {
        if (this.pendingTopologyRefreshTimeout) clearTimeout(this.pendingTopologyRefreshTimeout);
        const delay = Math.min(5000 * Math.pow(1.5, this.topologyRefreshAttempt), 30_000);
        this.pendingTopologyRefreshTimeout = setTimeout(() => {
            this.pendingTopologyRefreshTimeout = null;
            this.topologyRefreshAttempt++;
            this.refreshTopology();
        }, delay);
    }

    /**
     *  Server-side mirror of the renderer's `sendCurrentTrackToDlna`
     *  (dlna-player-engine.tsx L314).  Reads the current song from the
     *  session, uses the renderer-resolved `resolvedStreamUrl` /
     *  `resolvedAlbumArtUrl` / `resolvedMimeType` (the server has no
     *  Navidrome API client, so it can't resolve URLs itself), prepares
     *  a speed transcode if `player.speed !== 1`, and calls the existing
     *  `runPlayUrl` to issue `SetAVTransportURI` + `Play` to the device.
     *  Also pre-loads the next track via `setNextUrl` for gapless.
     */
    private async sendCurrentTrackFromSession(): Promise<void> {
        if (!this.connectedDevice) return;
        const song = this.session.getCurrentSong();
        if (!song || !song.resolvedStreamUrl) {
            this.dlnaLog('sendCurrentTrackFromSession: no current song or resolvedStreamUrl');
            return;
        }
        const generation = ++this.sendCurrentTrackGen;
        const player = this.session.snapshot().player;
        const rawUrl = song.resolvedStreamUrl;
        let urlToPlay: string = rawUrl;
        if (player.speed !== 1) {
            // Prepare a speed-transcoded file.  Mirrors the renderer's
            // loop: prepareSpeedFile → poll checkSpeedFile every 300ms
            // up to a 120s deadline.
            await this.transcoder.prepareSpeedFile({
                offset: 0,
                preservePitch: true, // server-side always preserves pitch
                speed: player.speed,
                url: rawUrl,
            });
            if (generation !== this.sendCurrentTrackGen) return;
            const deadline = Date.now() + 120_000;
            let readyUrl: null | string = null;
            while (!readyUrl && Date.now() < deadline) {
                await new Promise<void>((r) => setTimeout(r, 300));
                if (generation !== this.sendCurrentTrackGen) return;
                // Bail if the current song changed mid-transcode.
                const currentNow = this.session.getCurrentSong();
                if (!currentNow || currentNow._uniqueId !== song._uniqueId) return;
                readyUrl = await this.transcoder.checkSpeedFile({
                    preservePitch: true,
                    speed: player.speed,
                    url: rawUrl,
                });
            }
            if (!readyUrl || generation !== this.sendCurrentTrackGen) return;
            urlToPlay = readyUrl;
        }
        // Build DIDL-Lite metadata from the pre-resolved fields.
        const metadata: TrackMetadata = {
            albumArtUrl: song.resolvedAlbumArtUrl,
            albumName: song.album || undefined,
            artistName: song.artistName || song.artists?.[0]?.name || undefined,
            autoPlay: player.status !== PlayerStatus.STOPPED,
            duration: song.duration ? song.duration / 1000 : undefined,
            mimeType: song.resolvedMimeType || (player.speed !== 1 ? 'audio/mpeg' : undefined),
            title: song.name,
        };
        // Issue playUrl via the existing path (handles LAN rewrite,
        // SetAVTransportURI, play, mute-trick for seek, etc.).
        await this.runPlayUrl(this.connectedDevice, {
            isMuted: player.muted,
            metadata,
            seekTo: player.seekTo >= 0 ? player.seekTo : undefined,
            url: urlToPlay,
        });
        // Pre-load next track for gapless (only meaningful at speed = 1
        // since speed-transcoded files can't gapless on Sonos).
        if (player.speed === 1) {
            setTimeout(() => this.preloadNextTrackFromSession(), 1000);
        }
    }

    // ------------------------------------------------------------------
    // Internal: notify handlers
    // ------------------------------------------------------------------

    private sendGroupStateToRenderer(): void {
        const state = this.groupMembers.map((m) => ({
            device: m,
            isCoordinator:
                m.id === this.currentCoordinatorId ||
                (!this.currentCoordinatorId && m.id === this.connectedDevice?.id),
            volume: this.groupMemberVolumes[m.id] ?? 50,
        }));
        this.emit('rendererDlnaGroupState', state);
    }

    /**
     * Sends a single UPnP SUBSCRIBE request and resolves with the SID
     * returned by the device. Rejects on socket error, on missing SID
     * header, or after `timeoutMs` with no response.
     */
    private sendSubscribeRequest(
        parsedUrl: URL,
        callbackUrl: string,
        timeoutMsg: string,
        timeoutMs = 10_000,
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const req = http.request(
                {
                    headers: {
                        CALLBACK: `<${callbackUrl}>`,
                        NT: 'upnp:event',
                        TIMEOUT: 'Second-1800',
                    },
                    hostname: parsedUrl.hostname,
                    method: 'SUBSCRIBE',
                    path: parsedUrl.pathname,
                    port: parsedUrl.port || '1400',
                },
                (res) => {
                    const sid = res.headers['sid'] as string | undefined;
                    res.resume();
                    if (sid) resolve(sid);
                    else reject(new Error('No SID'));
                },
            );
            req.on('error', reject);
            req.setTimeout(timeoutMs, () => req.destroy(new Error(timeoutMsg)));
            req.end();
        });
    }

    private async startEventSubscription(device: DlnaDevice): Promise<void> {
        const lanIp = this.networkHelpers.getLanIp();
        if (!lanIp) {
            this.dlnaLog('Cannot subscribe to events: no LAN IP found');
            return;
        }
        await this.eventServer.ensureStarted();
        const callbackUrl = `http://${lanIp}:${this.eventServer.port}/notify`;
        try {
            const parsedUrl = new URL(this.getEventUrl(device));
            // Retry the SUBSCRIBE up to 3 times. Sonos devices sometimes
            // stall or drop a SUBSCRIBE request when an existing
            // subscription is in the process of being torn down (e.g., on
            // reconnect). Each attempt gets a generous 10s timeout; the
            // device typically responds within 1-2s when healthy.
            let sid: string | undefined;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    sid = await this.sendSubscribeRequest(
                        parsedUrl,
                        callbackUrl,
                        'SUBSCRIBE timed out',
                    );
                    break;
                } catch (err) {
                    if (attempt < 3) {
                        this.dlnaLog(
                            `AVTransport SUBSCRIBE attempt ${attempt}/3 failed, retrying...`,
                            err,
                        );
                        await new Promise((r) => setTimeout(r, 1500));
                    } else {
                        throw err;
                    }
                }
            }
            if (!sid) throw new Error('No SID');
            this.subscriptionSid = sid;
            this.dlnaLog(`Subscribed to AVTransport events (SID: ${sid})`);
            this.subscriptionRenewalTimeout = setTimeout(
                () => this.renewEventSubscription(device),
                25 * 60 * 1000,
            );
        } catch (err) {
            this.dlnaLog('Failed to subscribe to AVTransport events', err);
        }
    }

    private startPositionPolling(): void {
        this.stopPositionPolling();
        this.positionPollingInterval = setInterval(async () => {
            if (!this.connectedDevice) return;
            // Don't poll during the first few seconds after loading a track
            if (Date.now() - this.trackLoadedAt < 50) return;
            // Started polling much sooner, most of the failed DLNA commands I've seen occurred earlier than this, and position info
            // early in the song is good. I tested with a few configurations, this works well, I believe.
            try {
                const [posInfo, transportState] = await Promise.all([
                    getPositionInfo(this.connectedDevice),
                    getTransportInfo(this.connectedDevice),
                ]);
                let realPosition = posInfo.position;
                const proxyState = getActiveProxyState(this.lastCommandedUri);
                if (proxyState) {
                    realPosition = posInfo.position * proxyState.speed;
                }
                this.emit('rendererCurrentTime', realPosition);
                // Track that playback has started
                if (transportState === 'PLAYING' || transportState === 'TRANSITIONING')
                    this.hasStartedPlaying = true;

                const previousPosition = this.lastKnownPosition;
                this.lastKnownPosition = posInfo.position;
                const uriReportedByDevice =
                    !!posInfo.trackUri && posInfo.trackUri !== 'NOT_IMPLEMENTED';
                const recentAppSeek = Date.now() - this.lastAppSeekAt < 3000;
                // Detect gapless transition: position jumped backward significantly
                if (!this.isRadioMode) {
                    const isSameUriLoop =
                        this.lastQueuedNextUri === this.lastCommandedUri &&
                        this.lastQueuedNextUri !== '';
                    if (posInfo.trackUri === this.lastCommandedUri) {
                        this.lastLoadedFromUri = '';
                    }

                    if (
                        this.hasStartedPlaying &&
                        uriReportedByDevice &&
                        posInfo.trackUri !== this.lastCommandedUri &&
                        posInfo.trackUri !== this.lastLoadedFromUri &&
                        this.lastQueuedNextUri &&
                        posInfo.trackUri === this.lastQueuedNextUri
                    ) {
                        this.dlnaLog(`Polling: advanced to next track`);
                        this.lastCommandedUri = posInfo.trackUri;
                        this.lastQueuedNextUri = '';
                        this.trackLoadedAt = Date.now();
                        this.lastKnownPosition = 0;
                        this.handleDeviceTrackEnded({ gapless: true });
                    } else if (
                        this.hasStartedPlaying &&
                        isSameUriLoop &&
                        uriReportedByDevice &&
                        posInfo.trackUri === this.lastCommandedUri &&
                        previousPosition > 1 &&
                        posInfo.position < 2 &&
                        posInfo.position < previousPosition - 2 &&
                        !recentAppSeek
                    ) {
                        this.dlnaLog(`Polling: looped same track (gapless 1-loop)`);
                        this.trackLoadedAt = Date.now();
                        this.lastKnownPosition = 0;
                        this.pendingPrevTrack = false;
                        this.handleDeviceTrackEnded({ gapless: true });
                    }
                    const isGracePeriod = Date.now() - this.trackLoadedAt < 4000;
                    if (this.pendingPrevTrack) {
                        this.pendingPrevTrack = false;
                        if (!isGracePeriod && transportState !== 'STOPPED') {
                            this.dlnaLog(`Position-based prev confirmed`);
                            this.trackLoadedAt = Date.now();
                            this.lastKnownPosition = 0;
                            this.handleDevicePrevTrack();
                        }
                    }
                    if (
                        !isGracePeriod &&
                        !this.pendingPrevTrack &&
                        this.hasStartedPlaying &&
                        transportState !== 'STOPPED' &&
                        uriReportedByDevice &&
                        posInfo.trackUri === this.lastCommandedUri &&
                        previousPosition > 1 &&
                        posInfo.position < 2 &&
                        posInfo.position < previousPosition - 2 &&
                        !recentAppSeek
                    ) {
                        this.dlnaLog(
                            `Position-based prev pending: ${previousPosition}s -> ${posInfo.position}s`,
                        );
                        this.pendingPrevTrack = true;
                    }
                    const recentClearNext = Date.now() - this.lastClearNextAt < 3000;
                    let justFiredTrackEnded = false;
                    if (posInfo.duration > 0) this.lastKnownDuration = posInfo.duration;
                    if (
                        this.hasStartedPlaying &&
                        this.lastKnownDuration > 0 &&
                        posInfo.position > 0 &&
                        posInfo.position >= this.lastKnownDuration - 2 &&
                        Math.abs(posInfo.position - previousPosition) < 0.5 &&
                        !recentAppSeek
                    ) {
                        this.nearEndStallCount += 1;
                        if (this.nearEndStallCount >= 3) {
                            this.dlnaLog(
                                `Stuck-at-end detected (${posInfo.position}/${this.lastKnownDuration}s), advancing`,
                            );
                            this.nearEndStallCount = 0;
                            this.hasStartedPlaying = false;
                            this.lastKnownDuration = 0;
                            this.trackLoadedAt = Date.now();
                            this.handleDeviceTrackEnded({ gapless: false });
                        }
                    } else {
                        this.nearEndStallCount = 0;
                    }
                    if (
                        this.hasStartedPlaying &&
                        transportState === 'STOPPED' &&
                        !this.isPausedIntentionally &&
                        !recentClearNext
                    ) {
                        const isResumeFailure =
                            previousPosition < 15 ||
                            (Date.now() - this.trackLoadedAt < 12000 && previousPosition < 30);
                        if (isResumeFailure) {
                            this.resumeKickCount++;
                            if (this.resumeKickCount <= 4) {
                                this.dlnaLog(
                                    `Stream dropped unexpectedly (resume failure). Kicking device... (${this.resumeKickCount}/4)`,
                                );
                                this.trackLoadedAt = Date.now();
                                this.lastPlayCommandAt = Date.now();
                                play(this.connectedDevice).catch(() => {});
                            } else {
                                this.dlnaLog('Stream failed to resume after 4 attempts, giving up');
                                this.hasStartedPlaying = false;
                                this.isPausedIntentionally = true;
                                this.emit('rendererDlnaToast', {
                                    message:
                                        'DLNA stream failed to resume. Please try playing again.',
                                    type: 'error',
                                });
                            }
                        } else {
                            this.pendingPrevTrack = false;
                            this.dlnaLog('Track ended (stopped), advancing queue');
                            this.hasStartedPlaying = false;
                            this.lastKnownPosition = 0;
                            justFiredTrackEnded = true;
                            this.lastFinishedUri = this.lastCommandedUri;
                            this.lastCommandedUri = '';
                            this.handleDeviceTrackEnded({ gapless: false });
                        }
                    }
                    if (
                        !this.hasStartedPlaying &&
                        !justFiredTrackEnded &&
                        transportState === 'STOPPED' &&
                        !this.isPausedIntentionally &&
                        this.lastCommandedUri
                    ) {
                        const isStuck =
                            !this.hasStartedPlaying &&
                            this.trackLoadedAt > 0 &&
                            Date.now() - this.trackLoadedAt > 5000;

                        if (
                            isStuck &&
                            this.lastCommandedUri &&
                            this.lastCommandedUri !== this.lastFinishedUri
                        ) {
                            if (this.lastKnownTransportState !== 'TRANSITIONING') {
                                this.dlnaLog(
                                    'Stream startup slow/stuck in STOPPED. Kicking device...',
                                );
                                play(this.connectedDevice).catch(() => {});
                                this.trackLoadedAt = Date.now();
                            }
                        }
                    }
                } else if (this.hasStartedPlaying && transportState === 'STOPPED') {
                    this.hasStartedPlaying = false;
                    this.dlnaLog('Radio stream stopped on device');
                }

                if (
                    transportState !== this.lastKnownTransportState &&
                    transportState !== 'TRANSITIONING'
                ) {
                    this.lastKnownTransportState = transportState;
                    const recentPauseOrPlay =
                        Date.now() - this.lastPauseCommandAt < 2000 ||
                        Date.now() - this.lastPlayCommandAt < 2000;
                    const newTrackSentSincePause = this.lastPlayUrlSentAt > this.lastPauseCommandAt;
                    if (
                        !recentPauseOrPlay ||
                        (transportState === 'PLAYING' && newTrackSentSincePause)
                    ) {
                        this.emit('rendererDlnaTransportState', transportState);
                    }
                }

                try {
                    const deviceVolume = await getVolume(this.connectedDevice);
                    if (deviceVolume !== this.lastKnownDeviceVolume) {
                        this.lastKnownDeviceVolume = deviceVolume;
                        if (this.groupMembers.length > 0) {
                            this.groupMemberVolumes[this.connectedDevice.id] = deviceVolume;
                            this.emit('rendererDlnaGroupMemberVolume', {
                                deviceId: this.connectedDevice.id,
                                volume: deviceVolume,
                            });
                        }
                        this.emit('rendererDlnaVolume', deviceVolume);
                    }
                } catch {
                    // Volume errors are non-fatal
                }

                if (this.groupMembers.length > 1) {
                    for (const member of this.groupMembers) {
                        if (member.id === this.connectedDevice.id) continue;
                        try {
                            const vol = await getVolume(member);
                            if (vol !== this.groupMemberVolumes[member.id]) {
                                this.groupMemberVolumes[member.id] = vol;
                                this.emit('rendererDlnaGroupMemberVolume', {
                                    deviceId: member.id,
                                    volume: vol,
                                });
                            }
                        } catch {
                            // Non-fatal
                        }
                    }
                }
            } catch {
                // Polling errors are expected during track transitions
            }
        }, 500);
        // IMPORTANT: This used to be 1000, but I believe that was not tested explicitly and arbitrary, and we get
        // benefit from somewhat smaller polling intervals, so I changed it with tests. This might prove too small
        // for some network configurations, so if need be, I'll make this a setting later.
    }

    private startTopologyPolling(): void {
        if (this.topologyPollingInterval) clearInterval(this.topologyPollingInterval);
        this.topologyPollingInterval = setInterval(() => this.refreshTopology(), 4000);
    }

    private async startTopologySubscription(device: DlnaDevice): Promise<void> {
        const lanIp = this.networkHelpers.getLanIp();
        if (!lanIp) return;
        await this.eventServer.ensureStarted();
        const callbackUrl = `http://${lanIp}:${this.eventServer.port}/topology`;
        try {
            const parsedUrl = new URL(getTopologyEventUrl(device));
            // Same retry strategy as AVTransport subscribe — Sonos can
            // stall a topology SUBSCRIBE while it tears down a stale
            // subscription from a previous connect cycle.
            let sid: string | undefined;
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    sid = await this.sendSubscribeRequest(
                        parsedUrl,
                        callbackUrl,
                        'Topology SUBSCRIBE timed out',
                    );
                    break;
                } catch (err) {
                    if (attempt < 3) {
                        this.dlnaLog(
                            `Topology SUBSCRIBE attempt ${attempt}/3 failed, retrying...`,
                            err,
                        );
                        await new Promise((r) => setTimeout(r, 1500));
                    } else {
                        throw err;
                    }
                }
            }
            if (!sid) throw new Error('No SID');
            this.topologySubscriptionSid = sid;
            this.dlnaLog(`Subscribed to ZoneGroupTopology events (SID: ${sid})`);
            this.topologyRenewalTimeout = setTimeout(
                () => this.renewTopologySubscription(device),
                25 * 60 * 1000,
            );
        } catch (err) {
            this.dlnaLog('Failed to subscribe to ZoneGroupTopology events', err);
        }
    }

    // ------------------------------------------------------------------
    // Internal: position polling (the big one)
    // ------------------------------------------------------------------

    private async stopEventSubscription(device: DlnaDevice): Promise<void> {
        if (this.subscriptionRenewalTimeout) {
            clearTimeout(this.subscriptionRenewalTimeout);
            this.subscriptionRenewalTimeout = null;
        }
        if (!this.subscriptionSid) return;
        try {
            const parsedUrl = new URL(this.getEventUrl(device));
            await new Promise<void>((resolve) => {
                const req = http.request(
                    {
                        headers: { SID: this.subscriptionSid! },
                        hostname: parsedUrl.hostname,
                        method: 'UNSUBSCRIBE',
                        path: parsedUrl.pathname,
                        port: parsedUrl.port || '1400',
                    },
                    (res) => {
                        res.resume();
                        resolve();
                    },
                );
                req.on('error', () => resolve());
                req.setTimeout(3000, () => {
                    req.destroy();
                    resolve();
                });
                req.end();
            });
            this.dlnaLog('Unsubscribed from AVTransport events');
        } catch {
            // Catch
        }
        this.subscriptionSid = null;
    }

    private stopPositionPolling(): void {
        if (this.positionPollingInterval) {
            clearInterval(this.positionPollingInterval);
            this.positionPollingInterval = null;
        }
    }

    private async stopTopologySubscription(device: DlnaDevice): Promise<void> {
        if (this.topologyRenewalTimeout) {
            clearTimeout(this.topologyRenewalTimeout);
            this.topologyRenewalTimeout = null;
        }
        if (!this.topologySubscriptionSid) return;
        try {
            const parsedUrl = new URL(getTopologyEventUrl(device));
            await new Promise<void>((resolve) => {
                const req = http.request(
                    {
                        headers: { SID: this.topologySubscriptionSid! },
                        hostname: parsedUrl.hostname,
                        method: 'UNSUBSCRIBE',
                        path: parsedUrl.pathname,
                        port: parsedUrl.port || '1400',
                    },
                    (res) => {
                        res.resume();
                        resolve();
                    },
                );
                req.on('error', () => resolve());
                req.setTimeout(3000, () => {
                    req.destroy();
                    resolve();
                });
                req.end();
            });
            this.dlnaLog('Unsubscribed from ZoneGroupTopology events');
        } catch {
            // Catch
        }
        this.topologySubscriptionSid = null;
    }

    private async waitForTransportState(
        device: DlnaDevice,
        states: string[],
        maxWaitMs: number,
    ): Promise<void> {
        const interval = 150;
        const attempts = Math.ceil(maxWaitMs / interval);
        for (let i = 0; i < attempts; i++) {
            await new Promise((r) => setTimeout(r, interval));
            try {
                const state = await getTransportInfo(device);
                if (states.includes(state)) return;
            } catch {
                // Catch
            }
        }
    }
}

// ------------------------------------------------------------------
// Module-private helpers (stateless)
// ------------------------------------------------------------------

function fetchXml(url: string): Promise<string> {
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
        });
        req.on('error', () => resolve(''));
        req.setTimeout(3000, () => {
            req.destroy();
            resolve('');
        });
    });
}

function getActiveProxyState(uri: string) {
    if (!uri) return null;
    if (uri.includes('/audio-proxy')) {
        try {
            const urlObj = new URL(uri);
            return {
                offset: parseFloat(urlObj.searchParams.get('offset') || '0'),
                speed: parseFloat(urlObj.searchParams.get('speed') || '1'),
            };
        } catch {
            return null;
        }
    }
    const match = uri.match(/dlna-speed-[^-]+-s([0-9.]+)-p[01]\.mp3/);
    if (match) {
        return { offset: 0, speed: parseFloat(match[1]) };
    }
    return null;
}
