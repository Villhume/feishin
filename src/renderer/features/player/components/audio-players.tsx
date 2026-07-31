import type { WsDlnaClient } from '/@/renderer/features/player/api/dlna-ws-client';
import type { ErrorInfo, ReactNode } from 'react';

import isElectron from 'is-electron';
import { Component, useEffect, useState } from 'react';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { UserFavoriteEventPayload, UserRatingEventPayload } from '/@/renderer/events/events';
import { DiscordRpcHook } from '/@/renderer/features/discord-rpc/use-discord-rpc';
import { useCastSessionStore } from '/@/renderer/features/player/api/cast-session-store';
import { useDlnaClient } from '/@/renderer/features/player/api/dlna-client-provider';
import { useDlnaSessionSync } from '/@/renderer/features/player/api/dlna-session-sync';
import { DlnaPlayer } from '/@/renderer/features/player/audio-player/dlna-player';
import { MainPlayerListenerHook } from '/@/renderer/features/player/audio-player/hooks/use-main-player-listener';
import { JukeboxPlayer } from '/@/renderer/features/player/audio-player/jukebox-player';
import { MpvPlayer } from '/@/renderer/features/player/audio-player/mpv-player';
import { WebPlayer } from '/@/renderer/features/player/audio-player/web-player';
import { SleepTimerHook } from '/@/renderer/features/player/components/sleep-timer-button';
import { AutoDJHook } from '/@/renderer/features/player/hooks/use-auto-dj';
import { AutosaveHook } from '/@/renderer/features/player/hooks/use-autosave';
import { MediaSessionHook } from '/@/renderer/features/player/hooks/use-media-session';
import { MPRISHook } from '/@/renderer/features/player/hooks/use-mpris';
import { PlaybackHotkeysHook } from '/@/renderer/features/player/hooks/use-playback-hotkeys';
import { PowerSaveBlockerHook } from '/@/renderer/features/player/hooks/use-power-save-blocker';
import {
    InitialTimestampRestoreHook,
    QueueRestoreTimestampHook,
} from '/@/renderer/features/player/hooks/use-queue-restore';
import { ScrobbleHook } from '/@/renderer/features/player/hooks/use-scrobble';
import { UpdateCurrentSongHook } from '/@/renderer/features/player/hooks/use-update-current-song';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import { RadioDlnaPlayer } from '/@/renderer/features/radio/components/radio-dlna-player';
import { RadioWebPlayer } from '/@/renderer/features/radio/components/radio-web-player';
import {
    RadioAudioInstanceHook,
    RadioMetadataHook,
    useIsRadioActive,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { RemoteHook } from '/@/renderer/features/remote/hooks/use-remote';
import { VisualizerSystemAudioBridgeHook } from '/@/renderer/features/visualizer/components/visualizer-system-audio-bridge';
import { useSettingsStore } from '/@/renderer/store';
import {
    updateQueueFavorites,
    updateQueueRatings,
    useCastSettings,
    useCurrentServerId,
    usePlaybackSettings,
    usePlaybackType,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem } from '/@/shared/types/domain-types';
import { PlayerType } from '/@/shared/types/types';
const CODEC_PROBES = [
    { codec: 'mp3', container: 'mp3', mime: 'audio/mpeg' },

    { codec: 'aac', container: 'mp4', mime: 'audio/mp4; codecs="mp4a.40.2"' },
    { codec: 'aac', container: 'aac', mime: 'audio/aac' },
    { codec: 'aac', container: 'mp4', mime: 'audio/x-m4a' },

    { codec: 'opus', container: 'ogg', mime: 'audio/ogg; codecs="opus"' },
    { codec: 'opus', container: 'webm', mime: 'audio/webm; codecs="opus"' },

    { codec: 'vorbis', container: 'ogg', mime: 'audio/ogg; codecs="vorbis"' },
    { codec: 'vorbis', container: 'webm', mime: 'audio/webm; codecs="vorbis"' },

    { codec: 'flac', container: 'flac', mime: 'audio/flac' },

    { codec: ['pcm', 'wav'], container: 'wav', mime: 'audio/wav' },

    { codec: 'alac', container: 'mp4', mime: 'audio/mp4; codecs="alac"' },
];

const DEFAULT_TRANSCODING_PROFILES = [
    { audioCodec: 'flac', container: 'flac', protocol: 'http' },
    { audioCodec: 'opus', container: 'ogg', protocol: 'http' },
    { audioCodec: 'mp3', container: 'mp3', protocol: 'http' },
];

const SAFARI_TRANSCODING_PROFILES = [{ audioCodec: 'mp3', container: 'mp3', protocol: 'http' }];

const DIRECT_PLAY_PROFILES: {
    audioCodecs: string[];
    containers: string[];
    protocols: string[];
}[] = [];

export function getDefaultTranscodingProfiles() {
    return isSafari() ? SAFARI_TRANSCODING_PROFILES : DEFAULT_TRANSCODING_PROFILES;
}

export function getDirectPlayProfiles() {
    return DIRECT_PLAY_PROFILES;
}

// Shamelessly taken from NavidromeUI
function detectBrowserProfile() {
    const audio = new Audio();

    for (const { codec, container, mime } of CODEC_PROBES) {
        if (audio.canPlayType(mime) === 'maybe' || audio.canPlayType(mime) === 'probably') {
            DIRECT_PLAY_PROFILES.push({
                audioCodecs: Array.isArray(codec) ? codec : [codec],
                containers: [container],
                protocols: ['http'],
            });
        }
    }

    logger.debug('DIRECT_PLAY_PROFILES', DIRECT_PLAY_PROFILES);

    return DIRECT_PLAY_PROFILES;
}

function isSafari() {
    const ua = navigator.userAgent;
    return ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium');
}

export const AudioPlayers = () => {
    const playbackType = usePlaybackType();
    const serverId = useCurrentServerId();
    const { resetSampleRate, setSettings } = useSettingsStoreActions();
    // Subscribe to server-authoritative queue/player state events when a
    // WS-backed DLNA client is available. The hook internally no-ops when
    // the client is null or is the Electron IPC variant.
    const dlnaClient = useDlnaClient();
    useDlnaSessionSync(dlnaClient as null | WsDlnaClient);
    // `cast` is hydrated synchronously from localStorage by Zustand persist,
    // so it's available on first render (unlike `dlnaClient`, which resolves
    // only after the WS handshake). We read it here to determine whether this
    // tab is on the WS path (web/Docker: `auto` or `manual`) or the Electron
    // IPC path.
    const cast = useCastSettings();
    // DLNA requires an active connection — fall back to web on startup.
    // Skip the reset when this tab is on the WS path (web/Docker):
    //   - The WS casting server is the source of truth for the session.
    //   - On mount, the persisted `playbackType` may be DLNA (carried over
    //     from an earlier tab) but the WS handshake to the server hasn't
    //     completed yet (~100-500ms). Resetting to WEB here would cause the
    //     DLNA engine to unmount, then `onHello` remounts it — flickering
    //     the UI and potentially interrupting playback on the speaker.
    //   - When `onHello` arrives with `hello.connected === false` (no active
    //     session on the server — a stale persisted DLNA type), the handler
    //     in `dlna-client-provider.tsx` resets `playbackType` to WEB itself.
    // The reset is still needed in the Electron path where there's no WS
    // server keeping the session alive across app restarts.
    //
    // `castConnected` gates the DLNA engine render on the WS path.  When
    // `playbackType` is persisted as `DLNA` from a prior tab but the
    // `hello` handshake hasn't arrived yet, the player store still has
    // default state (status=PAUSED, index=0, seekTo=-1).  Rendering the
    // DLNA engine in that window shows "paused at position 0" briefly
    // before `onHello` applies the snapshot.  Holding `null` until
    // `castConnected` flips ensures the engine mounts only after the
    // snapshot is in the store — no UI flash, no spurious commands.
    const castConnected = useCastSessionStore((s) => s.isConnected);
    const [mountChecked, setMountChecked] = useState(false);
    useEffect(() => {
        if (playbackType === PlayerType.DLNA) {
            const isWsPath = cast.mode === 'auto' || cast.mode === 'manual';
            if (isWsPath) {
                // WS path — let `onHello` drive the state. Skip the reset.
            } else {
                setSettings({ playback: { type: PlayerType.WEB } });
            }
        }
        setMountChecked(true);
        // Only run on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const {
        audioDeviceId,
        mpvProperties: { audioSampleRateHz },
        webAudio,
    } = usePlaybackSettings();
    const { setWebAudio, webAudio: audioContext } = useWebAudio();
    useEffect(() => {
        detectBrowserProfile();
    }, []);
    // On the WS path, if `playbackType` is persisted as `DLNA` but no
    // session is connected yet, hold off rendering any engine until the
    // `hello` handshake arrives.  This prevents (a) the DLNA engine from
    // mounting with default state (paused/position 0), and (b) the WEB
    // player from briefly mounting and potentially starting local audio
    // playback with the persisted queue.  Must come AFTER all hooks to
    // satisfy `react-hooks/rules-of-hooks`.
    const isWsPath = cast.mode === 'auto' || cast.mode === 'manual';
    const waitingForHello = isWsPath && playbackType === PlayerType.DLNA && !castConnected;
    if (!mountChecked || waitingForHello) return null;
    return (
        <>
            <SleepTimerHook />
            <ScrobbleHook />
            <PowerSaveBlockerHook />
            <DiscordRpcHook />
            <MPRISHook />
            <MainPlayerListenerHook />
            <MediaSessionHook />
            <PlaybackHotkeysHook />
            <RemoteHook />
            <AutoDJHook />
            <QueueRestoreTimestampHook />
            <InitialTimestampRestoreHook />
            <UpdateCurrentSongHook />
            <RadioAudioInstanceHook />
            <RadioMetadataHook />
            <VisualizerSystemAudioBridgeHook />
            <AutosaveHook />
            <AudioPlayersContent
                audioContext={audioContext}
                audioDeviceId={audioDeviceId}
                audioSampleRateHz={audioSampleRateHz}
                playbackType={playbackType}
                resetSampleRate={resetSampleRate}
                serverId={serverId}
                setWebAudio={setWebAudio}
                webAudio={webAudio}
            />
        </>
    );
};

const mpvPlayerListener = isElectron() ? window.api.mpvPlayerListener : null;

const AudioPlayersContent = ({
    audioContext,
    audioDeviceId,
    audioSampleRateHz,
    playbackType,
    resetSampleRate,
    serverId,
    setWebAudio,
    webAudio,
}: {
    audioContext: ReturnType<typeof useWebAudio>['webAudio'];
    audioDeviceId: null | string | undefined;
    audioSampleRateHz: number | undefined;
    playbackType: PlayerType;
    resetSampleRate: ReturnType<typeof useSettingsStoreActions>['resetSampleRate'];
    serverId: null | string;
    setWebAudio: ReturnType<typeof useWebAudio>['setWebAudio'];
    webAudio: boolean;
}) => {
    const isRadioActive = useIsRadioActive();

    useEffect(() => {
        logger.info('Playback engine', { playbackType });
    }, [playbackType]);

    useEffect(() => {
        if (!mpvPlayerListener) {
            return;
        }

        mpvPlayerListener.rendererPlayerFallback((isFallback: boolean) => {
            if (isFallback) {
                logger.warn('Playback engine fell back to web');
            } else {
                logger.info('Playback engine using local (mpv)');
            }
        });
    }, []);

    useEffect(() => {
        // Web Audio API requires CORS-compliant audio sources.  In web/Docker
        // mode the audio element streams directly from a Navidrome server on
        // another origin, which does not return CORS headers, so
        // `createMediaElementSource()` would output silence.  Restrict Web
        // Audio (EQ, compressor, replay-gain, visualizer) to Electron where
        // the main process can route the audio through its own stream proxy.
        if (!isElectron() || !webAudio || !('AudioContext' in window)) {
            return;
        }
        let context: AudioContext;

        try {
            context = new AudioContext({
                latencyHint: 'playback',
                sampleRate: audioSampleRateHz || undefined,
            });
        } catch (error) {
            // In practice, this should never be hit because the UI should validate
            // the range. However, the actual supported range is not guaranteed
            toast.error({ message: (error as Error).message });
            context = new AudioContext({ latencyHint: 'playback' });
            resetSampleRate();
        }

        const gains = [context.createGain(), context.createGain()];

        // Build DSP chain from persisted settings so EQ/compressor
        // are active immediately on first playback, not just after
        // the user opens the settings panel.
        const { compressor, equalizer } = useSettingsStore.getState().playback;

        // Preamp gain — converts dB to linear
        const preampGain = context.createGain();
        preampGain.gain.value = equalizer.enabled ? Math.pow(10, equalizer.preamp / 20) : 1;

        // One peaking BiquadFilterNode per EQ band
        const eqFilters: BiquadFilterNode[] = equalizer.bands.map((band) => {
            const filter = context.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = band.freq;
            // Q of 1.41 gives roughly 1-octave bandwidth per band
            filter.Q.value = 1.41;
            filter.gain.value = equalizer.enabled ? band.gain : 0;
            return filter;
        });

        // DynamicsCompressorNode — always present, pass-through when disabled
        // (ratio=1, threshold=0 = mathematically transparent)
        const compressorNode = context.createDynamicsCompressor();
        if (compressor.enabled) {
            compressorNode.threshold.value = compressor.threshold;
            compressorNode.ratio.value = compressor.ratio;
            compressorNode.attack.value = compressor.attack / 1000;
            compressorNode.release.value = compressor.release / 1000;
            compressorNode.knee.value = compressor.knee;
        } else {
            compressorNode.threshold.value = 0;
            compressorNode.ratio.value = 1;
            compressorNode.attack.value = 0;
            compressorNode.release.value = 0.25;
            compressorNode.knee.value = 0;
        }

        // Wire: each gain → preamp → eq[0] → eq[1] → ... → compressor → destination
        for (const gain of gains) {
            gain.connect(preampGain);
        }

        if (eqFilters.length > 0) {
            preampGain.connect(eqFilters[0]);
            for (let i = 0; i < eqFilters.length - 1; i++) {
                eqFilters[i].connect(eqFilters[i + 1]);
            }
            eqFilters[eqFilters.length - 1].connect(compressorNode);
        } else {
            preampGain.connect(compressorNode);
        }

        compressorNode.connect(context.destination);

        setWebAudio!({
            context,
            dsp: { compressor: compressorNode, eqFilters, preampGain },
            gains,
        });

        // Intentionally ignore the sample rate dependency, as it makes things really messy
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        // Not standard, just used in chromium-based browsers. See
        // https://developer.chrome.com/blog/audiocontext-setsinkid/.

        if (!isElectron()) {
            return;
        }

        if (playbackType !== PlayerType.WEB) {
            return;
        }

        if (audioContext && 'setSinkId' in audioContext.context && audioDeviceId) {
            const setSink = async () => {
                try {
                    if (audioContext.context.state !== 'closed') {
                        await (audioContext.context as any).setSinkId(audioDeviceId);
                    }
                } catch (error) {
                    toast.error({ message: `Error setting sink: ${(error as Error).message}` });
                }
            };

            setSink();
        }
    }, [audioContext, audioDeviceId, playbackType]);

    // Listen to favorite and rating events to update queue songs
    useEffect(() => {
        const handleFavorite = (payload: UserFavoriteEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueFavorites(payload.id, payload.favorite);
        };

        const handleRating = (payload: UserRatingEventPayload) => {
            if (payload.itemType !== LibraryItem.SONG || payload.serverId !== serverId) {
                return;
            }

            updateQueueRatings(payload.id, payload.rating);
        };

        eventEmitter.on('USER_FAVORITE', handleFavorite);
        eventEmitter.on('USER_RATING', handleRating);

        return () => {
            eventEmitter.off('USER_FAVORITE', handleFavorite);
            eventEmitter.off('USER_RATING', handleRating);
        };
    }, [serverId]);

    if (isRadioActive && playbackType === PlayerType.LOCAL) {
        return <MpvPlayer />;
    }

    if (isRadioActive && playbackType === PlayerType.WEB) {
        return <RadioWebPlayer />;
    }
    if (isRadioActive && playbackType === PlayerType.DLNA) {
        return (
            <DlnaErrorBoundary>
                <RadioDlnaPlayer />
            </DlnaErrorBoundary>
        );
    }
    return (
        <>
            {playbackType === PlayerType.WEB && <WebPlayer />}
            {playbackType === PlayerType.LOCAL && <MpvPlayer />}
            {playbackType === PlayerType.JUKEBOX && <JukeboxPlayer />}
            {playbackType === PlayerType.DLNA && (
                <DlnaErrorBoundary>
                    <DlnaPlayer />
                </DlnaErrorBoundary>
            )}
        </>
    );
};

class DlnaErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
    constructor(props: { children: ReactNode }) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        console.error('[DLNA] Player error:', error, info);
    }

    render() {
        if (this.state.error) {
            return <div id="dlna-player-error" style={{ display: 'none' }} />;
        }
        return this.props.children;
    }
}
