import type { RefObject } from 'react';

import { useCallback, useContext, useEffect, useImperativeHandle, useRef } from 'react';

import { playerHandoff } from './player-handoff';

import { api } from '/@/renderer/api';
import { DlnaClientContext } from '/@/renderer/features/player/api/dlna-client-provider';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { AudioPlayer } from '/@/renderer/features/player/audio-player/types';
import {
    TranscodingConfig,
    usePlaybackSettings,
    usePlayerActions,
    usePlayerStore,
    useSettingsStore,
} from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';

export interface DlnaPlayerEngineHandle extends AudioPlayer {}

export const pendingInitialSeek = { value: -1 };

export type SongWithAudioMeta = {
    contentType?: null | string;
    suffix?: null | string;
};

interface DlnaPlayerEngineProps {
    isMuted: boolean;
    onEnded: () => void;
    playerRef: RefObject<DlnaPlayerEngineHandle | null>;
    playerStatus: PlayerStatus;
    volume: number;
}
const SUFFIX_MIME_MAP: Record<string, string> = {
    aac: 'audio/aac',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    ogg: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus',
    wav: 'audio/wav',
    wma: 'audio/x-ms-wma',
};

const FORMAT_MIME_MAP: Record<string, string> = {
    aac: 'audio/aac',
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg; codecs=opus',
    raw: '',
};

export async function getDlnaUrl(
    song: QueueSong,
    transcode: TranscodingConfig,
): Promise<string | undefined> {
    const { contentType, suffix } = song as unknown as SongWithAudioMeta;
    if (isOpusByMetadata({ contentType, suffix })) {
        const mp3Url = await getSongUrl(song, { ...transcode, enabled: true, format: 'mp3' });
        return mp3Url;
    }
    // Detection falls back to a probe of the actual stream if there isn't a positive from the initial metadata/suffix test
    const probeUrl = await getSongUrl(song, { ...transcode, enabled: false }, true);
    if (probeUrl) {
        const isOpus = await probeIsOpusOgg(probeUrl);
        if (isOpus) {
            const mp3Url = await getSongUrl(song, { ...transcode, enabled: true, format: 'mp3' });
            return mp3Url ?? probeUrl;
        }
        if (isOggByMetadata({ contentType, suffix })) {
            const mp3Url = await getSongUrl(song, { ...transcode, enabled: true, format: 'mp3' });
            return mp3Url ?? probeUrl;
        }
    }
    const playbackUrl = await getSongUrl(song, transcode);
    return playbackUrl;
}

export async function resolveMimeType(
    url: string,
    contentType?: null | string,
    suffix?: null | string,
): Promise<string> {
    const fromMetadata = getMimeType(url, contentType, suffix);
    if (fromMetadata !== 'audio/mpeg') return fromMetadata;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        const ct = res.headers.get('content-type');
        if (ct?.startsWith('audio/')) return ct.split(';')[0].trim();
    } catch {
        // Handle
    }
    return 'audio/mpeg';
}

function extractDlnaId(url: string): string {
    try {
        const u = new URL(url);
        return (
            u.searchParams.get('id') ||
            u.searchParams.get('itemId') ||
            u.searchParams.get('Id') ||
            ''
        );
    } catch {
        return '';
    }
}

async function findQueueMatchForUris(
    deviceCurrentUri: string,
    deviceNextUri: string,
): Promise<null | { index: number; matchedSong: QueueSong; matchedUrl: string }> {
    const state = usePlayerStore.getState();
    const items = state.getQueue().items;
    if (items.length === 0 || !deviceCurrentUri) return null;
    const urls = await Promise.all(
        items.map(async (song) => {
            try {
                return await getSongUrl(song, { enabled: false }, true);
            } catch {
                return undefined;
            }
        }),
    );
    for (let i = 0; i < items.length; i++) {
        const url = urls[i];
        if (!url) continue;
        if (!urisMatch(url, deviceCurrentUri)) continue;
        const hasNextInQueue = i + 1 < items.length;
        if (deviceNextUri && hasNextInQueue) {
            const nextUrl = urls[i + 1];
            if (!nextUrl || !urisMatch(nextUrl, deviceNextUri)) continue;
        }
        if (deviceNextUri && !hasNextInQueue) continue;
        return { index: i, matchedSong: items[i], matchedUrl: url };
    }
    return null;
}

function getMimeType(url: string, contentType?: null | string, suffix?: null | string): string {
    const formatMatch = url.match(/[?&]format=([^&]+)/i);
    if (formatMatch) {
        const fmt = formatMatch[1].toLowerCase();
        const mime = FORMAT_MIME_MAP[fmt];
        if (mime) return mime;
    }
    if (contentType?.startsWith('audio/')) return contentType;
    if (suffix) {
        const mapped = SUFFIX_MIME_MAP[suffix.toLowerCase()];
        if (mapped) return mapped;
    }
    const path = url.split('?')[0].toLowerCase();
    for (const [ext, mime] of Object.entries(SUFFIX_MIME_MAP)) {
        if (path.endsWith(`.${ext}`)) return mime;
    }
    return 'audio/mpeg';
}

function isOggByMetadata(song: SongWithAudioMeta): boolean {
    if (song.suffix?.toLowerCase() === 'ogg') return true;
    const ct = song.contentType?.toLowerCase();
    if (ct?.includes('ogg') || ct?.includes('vorbis')) return true;
    return false;
}

function isOpusByMetadata(song: SongWithAudioMeta): boolean {
    if (song.suffix?.toLowerCase() === 'opus') return true;
    if (song.contentType?.toLowerCase().includes('opus')) return true;
    return false;
}

// Identification here is by looking at the first 36 bytes in the OGG stream for the OPUS magic header in bytes 28-35
// Obviously, doing this client-side isn't ideal, but this was the only thing that worked with my files.
// I think that all of the providers detect OPUS on their side anyway, so at some point, I'll modify the APIs instead.
async function probeIsOpusOgg(url: string): Promise<boolean> {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 2000);
    try {
        const res = await fetch(url, {
            headers: { Range: 'bytes=0-35' },
            signal: controller.signal,
        });
        if (!res.ok && res.status !== 206) {
            return false;
        }
        if (!res.body) {
            return false;
        }
        const reader = res.body.getReader();
        const bytes = new Uint8Array(36);
        let offset = 0;
        while (offset < 36) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            const copy = Math.min(value.length, 36 - offset);
            bytes.set(value.subarray(0, copy), offset);
            offset += copy;
        }
        reader.cancel();
        if (offset < 36) {
            return false;
        }
        const result =
            bytes[28] === 0x4f &&
            bytes[29] === 0x70 && // 'O' 'p'
            bytes[30] === 0x75 &&
            bytes[31] === 0x73 && // 'u' 's'
            bytes[32] === 0x48 &&
            bytes[33] === 0x65 && // 'H' 'e'
            bytes[34] === 0x61 &&
            bytes[35] === 0x64; // 'a' 'd'
        return result;
    } catch {
        return false;
    } finally {
        clearTimeout(tid);
    }
}

function urisMatch(a: string, b: string): boolean {
    if (!a || !b) return false;
    const aId = extractDlnaId(a);
    const bId = extractDlnaId(b);
    if (aId && bId) return aId === bId;
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.pathname === ub.pathname;
    } catch {
        return a.split('?')[0] === b.split('?')[0];
    }
}

export const DlnaPlayerEngine = (props: DlnaPlayerEngineProps) => {
    const { isMuted, onEnded, playerRef, playerStatus, volume } = props;
    // Source of truth for the DLNA backend: in Electron this wraps
    // window.api.dlnaPlayer (IPC); in web/Docker it wraps a WsDlnaClient
    // connected to a standalone casting server. Both expose the same
    // DlnaClient interface. The `clientKey` is used as an effect dependency
    // so subscriptions are re-registered after a client swap.
    const { client: dlnaPlayer, clientKey } = useContext(DlnaClientContext);
    // Stable ref to the current DLNA client. The memoized callbacks and
    // effects below (sendCurrentTrackToDlna, playerStatus effect, volume/mute
    // effects, usePlayerEvents) read from this ref instead of the
    // `dlnaPlayer` variable so they always see the latest client without
    // needing it in their dependency arrays. Without this, the callbacks
    // capture `null` on first render (before the WS handshake completes) and
    // silently no-op every subsequent call — the stale-closure bug that
    // prevented playback from working in the web/Docker path.
    const dlnaPlayerRef = useRef(dlnaPlayer);
    dlnaPlayerRef.current = dlnaPlayer;
    const { transcode } = usePlaybackSettings();
    const { mediaPause, mediaPlay, mediaPlayByIndex, mediaPrevious, setTimestamp } =
        usePlayerActions();
    const hasPlayedRef = useRef(false);
    const skipNextSendRef = useRef(false);
    const lastSentUrlRef = useRef<string>('');
    // Define sendCurrentTrackToDlna BEFORE any effects that reference it
    const lastSentRawUrlRef = useRef<string>('');
    const lastSentAtRef = useRef<number>(0);
    const recentTrackEndedAtRef = useRef<number>(0);
    const TRACK_ENDED_PREV_SUPPRESSION_MS = 4000;
    const sameUriLoopQueuedRef = useRef(false);
    const wasNearEndRef = useRef(false);
    const currentSongDurationRef = useRef<number>(0);
    const preservePitchRef = useRef(useSettingsStore.getState().playback?.preservePitch ?? true);
    const isAutoAdvancingRef = useRef(false);
    const devicePassiveModeRef = useRef(false);
    const repeatChangedAtRef = useRef(0);
    const speakerSidePlayRef = useRef(false);
    const speakerSidePauseRef = useRef(false);
    const mountHandoffInProgressRef = useRef(false);
    const sendCurrentTrackGenRef = useRef(0);
    const justLoadedTrackRef = useRef(false);
    const suppressDeviceSeekRef = useRef(false);
    useEffect(() => {
        const unsubscribe = useSettingsStore.subscribe(
            (state) => state.playback.preservePitch,
            (newPreservePitch) => {
                preservePitchRef.current = newPreservePitch;
            },
        );
        return () => unsubscribe();
    }, []);
    const sendCurrentTrackToDlna = useCallback(async () => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        // Server-authoritative session: the server owns the queue and
        // issues its own `playUrl` via `sendCurrentTrackFromSession()`.
        // The renderer is just a mirror — sending `playUrl` from here
        // would race with the server's call and double-load the track.
        if (usePlayerStore.getState().isDlnaMode) {
            return;
        }
        const generation = ++sendCurrentTrackGenRef.current;
        const wasPlayingAtStart = usePlayerStore.getState().player.status === PlayerStatus.PLAYING;
        const wasAutoAdvancingAtStart = isAutoAdvancingRef.current;
        const playerData = usePlayerStore.getState().getPlayerData();
        const song = playerData.currentSong;
        if (!song) return;
        const currentSpeed = usePlayerStore.getState().player.speed || 1;
        const rawUrl = await getDlnaUrl(song, transcode);
        if (!rawUrl) return;
        let urlToPlay = rawUrl;
        let isProxy = false;
        if (currentSpeed !== 1) {
            await client.prepareSpeedFile({
                offset: 0,
                preservePitch: preservePitchRef.current,
                speed: currentSpeed,
                url: rawUrl,
            });
            if (generation !== sendCurrentTrackGenRef.current) return;
            const songId = song.id;
            let readyUrl: null | string = null;
            const deadline = Date.now() + 120_000;
            while (!readyUrl && Date.now() < deadline) {
                await new Promise<void>((r) => setTimeout(r, 300));
                if (generation !== sendCurrentTrackGenRef.current) return;
                if (usePlayerStore.getState().getPlayerData().currentSong?.id !== songId) return;
                readyUrl = await client.checkSpeedFile({
                    preservePitch: preservePitchRef.current,
                    speed: currentSpeed,
                    url: rawUrl,
                });
            }
            if (!readyUrl || generation !== sendCurrentTrackGenRef.current) return;
            urlToPlay = readyUrl;
            isProxy = true;
        } else {
            client.destroySpeedProxy?.();
        }
        if (skipNextSendRef.current) {
            skipNextSendRef.current = false;
            lastSentUrlRef.current = urlToPlay;
            lastSentRawUrlRef.current = rawUrl;
            lastSentAtRef.current = Date.now();
            return;
        }
        const now = Date.now();
        if (urlToPlay === lastSentUrlRef.current && now - lastSentAtRef.current < 500) {
            return;
        }
        lastSentUrlRef.current = urlToPlay;
        lastSentRawUrlRef.current = rawUrl;
        lastSentAtRef.current = now;
        wasNearEndRef.current = false;
        const durationSeconds = song.duration ? song.duration / 1000 : 0;
        currentSongDurationRef.current = isProxy ? durationSeconds / currentSpeed : durationSeconds;
        let albumArtUrl: string | undefined;
        try {
            albumArtUrl =
                api.controller.getImageUrl({
                    apiClientProps: { serverId: song._serverId },
                    query: {
                        id: song.albumId || song.id,
                        itemType: LibraryItem.ALBUM,
                        size: 600,
                    },
                }) || undefined;
        } catch {
            // Ignore image URL errors
        }
        const { contentType, suffix } = song as unknown as SongWithAudioMeta;
        const mimeType = isProxy
            ? 'audio/mpeg'
            : await resolveMimeType(rawUrl, contentType, suffix);
        const isCurrentlyPlaying = usePlayerStore.getState().player.status === PlayerStatus.PLAYING;
        const shouldAutoPlay =
            isAutoAdvancingRef.current ||
            wasAutoAdvancingAtStart ||
            isCurrentlyPlaying ||
            wasPlayingAtStart;
        if (!shouldAutoPlay && !hasPlayedRef.current) {
            return;
        }
        let targetSeek = 0;
        if (playerHandoff.pendingDlnaSeek >= 0) {
            targetSeek = playerHandoff.pendingDlnaSeek;
            playerHandoff.pendingDlnaSeek = -1;
        } else if (pendingInitialSeek.value >= 0) {
            targetSeek = pendingInitialSeek.value;
            pendingInitialSeek.value = -1;
        }
        justLoadedTrackRef.current = true;
        client.playUrl(
            urlToPlay,
            {
                albumArtUrl,
                albumName: song.album || undefined,
                artistName: song.artistName || song.artists?.[0]?.name || undefined,
                autoPlay: shouldAutoPlay,
                duration: currentSongDurationRef.current,
                mimeType,
                title: song.name,
            },
            { isMuted: props.isMuted, seekTo: targetSeek },
        );
        hasPlayedRef.current = true;
        isAutoAdvancingRef.current = false;
        setTimeout(async () => {
            const freshState = usePlayerStore.getState().getPlayerData();
            // Pre-load the next track for gapless playback
            const nextSong = freshState.nextSong;
            if (nextSong && currentSpeed === 1) {
                const { contentType: nextContentType, suffix: nextSuffix } =
                    nextSong as unknown as SongWithAudioMeta;
                const nextUrl = await getDlnaUrl(nextSong, transcode);
                if (nextUrl) {
                    sameUriLoopQueuedRef.current = nextUrl === rawUrl;
                    let nextArtUrl: string | undefined;
                    try {
                        nextArtUrl =
                            api.controller.getImageUrl({
                                apiClientProps: { serverId: nextSong._serverId },
                                query: {
                                    id: nextSong.albumId || nextSong.id,
                                    itemType: LibraryItem.ALBUM,
                                    size: 600,
                                },
                            }) || undefined;
                    } catch {
                        // Ignore image URL errors
                    }
                    const nextMimeType = await resolveMimeType(
                        nextUrl,
                        nextContentType,
                        nextSuffix,
                    );
                    dlnaPlayerRef.current?.setNextUrl(nextUrl, {
                        albumArtUrl: nextArtUrl,
                        albumName: nextSong.album || undefined,
                        artistName: nextSong.artistName || nextSong.artists?.[0]?.name || undefined,
                        duration: nextSong.duration ? nextSong.duration / 1000 : undefined,
                        mimeType: nextMimeType,
                        title: nextSong.name,
                    });
                } else {
                    sameUriLoopQueuedRef.current = false;
                }
            } else {
                sameUriLoopQueuedRef.current = false;
                setTimeout(() => {
                    dlnaPlayerRef.current?.clearNextUrl();
                }, 2000);
            }
        }, 1000);
    }, [transcode, props.isMuted]);
    const sendNextTrackDebounceRef = useRef<null | ReturnType<typeof setTimeout>>(null);
    const sendNextTrackToDlna = useCallback(() => {
        // Server-authoritative session: the server preloads the next track
        // via `preloadNextTrackFromSession()`. Skip the renderer-side
        // `setNextUrl` call entirely to avoid racing the server's call.
        if (usePlayerStore.getState().isDlnaMode) return;
        if (sendNextTrackDebounceRef.current !== null) {
            clearTimeout(sendNextTrackDebounceRef.current);
        }
        const msSinceRepeatChange = Date.now() - repeatChangedAtRef.current;
        const debounceMs = msSinceRepeatChange < 2000 ? 2000 - msSinceRepeatChange + 100 : 80;
        sendNextTrackDebounceRef.current = setTimeout(async () => {
            sendNextTrackDebounceRef.current = null;
            const client = dlnaPlayerRef.current;
            if (!client) return;
            const currentSpeed = usePlayerStore.getState().player.speed || 1;
            if (currentSpeed !== 1) return;
            const playerData = usePlayerStore.getState().getPlayerData();
            const nextSong = playerData.nextSong;
            if (!nextSong) {
                client.clearNextUrl();
                return;
            }
            const { contentType: nextContentType, suffix: nextSuffix } =
                nextSong as unknown as SongWithAudioMeta;
            const nextUrl = await getDlnaUrl(nextSong, transcode);
            if (!nextUrl) return;
            sameUriLoopQueuedRef.current = nextUrl === lastSentUrlRef.current;
            let nextArtUrl: string | undefined;
            try {
                nextArtUrl =
                    api.controller.getImageUrl({
                        apiClientProps: { serverId: nextSong._serverId },
                        query: {
                            id: nextSong.albumId || nextSong.id,
                            itemType: LibraryItem.ALBUM,
                            size: 600,
                        },
                    }) || undefined;
            } catch {
                // Ignore image URL errors
            }
            const mimeType = await resolveMimeType(nextUrl, nextContentType, nextSuffix);
            client.setNextUrl(nextUrl, {
                albumArtUrl: nextArtUrl,
                albumName: nextSong.album || undefined,
                artistName: nextSong.artistName || nextSong.artists?.[0]?.name || undefined,
                duration: nextSong.duration ? nextSong.duration / 1000 : undefined,
                mimeType,
                title: nextSong.name,
            });
        }, debounceMs);
    }, [transcode]);

    useEffect(() => {
        if (playerHandoff.deviceAlreadyPlaying) {
            // The server emits `rendererDlnaConnectPlayback` *before* the
            // connect RPC result returns, so the event listener in the
            // effect below isn't registered yet and the event is dropped.
            // We reconstruct the event handler's logic here using the
            // ConnectResult data passed through playerHandoff.
            const transportState = playerHandoff.deviceTransportState;
            const deviceUri = playerHandoff.deviceCurrentUri;
            const deviceNextUri = playerHandoff.deviceNextUri;
            const devicePosition = playerHandoff.devicePosition;
            playerHandoff.deviceAlreadyPlaying = false;
            playerHandoff.deviceWasPaused = false;
            playerHandoff.deviceTransportState = '';
            playerHandoff.deviceCurrentUri = '';
            playerHandoff.deviceNextUri = '';
            playerHandoff.devicePosition = 0;
            mountHandoffInProgressRef.current = true;
            hasPlayedRef.current = true;
            devicePassiveModeRef.current = false;
            // Replicate the rendererDlnaConnectPlayback event handler:
            // match the device's URI to a queue entry, select it, set
            // position, then play/pause.  This is async because
            // findQueueMatchForUris and getDlnaUrl do IPC/RPC calls.
            (async () => {
                const match = deviceUri
                    ? await findQueueMatchForUris(deviceUri, deviceNextUri)
                    : null;
                if (match) {
                    const playerData = usePlayerStore.getState().getPlayerData();
                    const isAlreadyCurrent =
                        playerData.currentSong?._uniqueId === match.matchedSong._uniqueId;
                    let trackedUrl = match.matchedUrl;
                    try {
                        const fullUrl = await getDlnaUrl(match.matchedSong, transcode);
                        if (fullUrl) trackedUrl = fullUrl;
                    } catch {
                        // Fallback
                    }
                    if (!isAlreadyCurrent) {
                        mediaPlayByIndex?.(match.index);
                    }
                    if (devicePosition > 0) setTimestamp(Math.floor(devicePosition));
                    lastSentRawUrlRef.current = trackedUrl;
                    lastSentUrlRef.current = trackedUrl;
                    lastSentAtRef.current = Date.now();
                    wasNearEndRef.current = false;
                }
                if (playerStatus === PlayerStatus.PLAYING) {
                    if (pendingInitialSeek.value >= 0) {
                        const seekTarget = pendingInitialSeek.value;
                        pendingInitialSeek.value = -1;
                        dlnaPlayerRef.current?.seek(seekTarget);
                    }
                    dlnaPlayerRef.current?.play();
                } else if (transportState === 'PLAYING') {
                    pendingInitialSeek.value = -1;
                    speakerSidePlayRef.current = true;
                    suppressDeviceSeekRef.current = true;
                    mediaPlay?.();
                } else if (
                    transportState === 'PAUSED_PLAYBACK' &&
                    usePlayerStore.getState().player.status !== PlayerStatus.PAUSED
                ) {
                    speakerSidePauseRef.current = true;
                    mediaPause?.();
                }
                mountHandoffInProgressRef.current = false;
            })();
            return;
        } else {
            if (playerStatus !== PlayerStatus.PLAYING) {
                pendingInitialSeek.value = -1;
            }
            devicePassiveModeRef.current = true;
        }
        if (playerStatus === PlayerStatus.PLAYING) {
            sendCurrentTrackToDlna();
        }
        // Only run on mount
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Listen for position updates from main process / casting server
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handleCurrentTime = (time: number) => {
            if (
                !wasNearEndRef.current &&
                currentSongDurationRef.current > 0 &&
                time >= currentSongDurationRef.current * 0.9
            ) {
                wasNearEndRef.current = true;
            }
            setTimestamp(Math.floor(time));
        };
        return dlnaPlayer.on('rendererCurrentTime', handleCurrentTime);
    }, [setTimestamp, dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = async (info: {
            duration: number;
            nextUri: string;
            position: number;
            transportState: string;
            uri: string;
        }) => {
            // Server-authoritative session: the server owns the queue, the
            // URI→queue-index mapping, and the player state.  It pushes
            // `rendererQueueState` / `rendererPlayerState` events directly,
            // which `useDlnaSessionSync` applies to the store.  Replaying
            // the legacy "match the device URI to a queue entry" flow here
            // would race with the server's snapshot and double-select.
            if (usePlayerStore.getState().isDlnaMode) return;
            mountHandoffInProgressRef.current = true;
            hasPlayedRef.current = true;
            devicePassiveModeRef.current = false;
            const match = info.uri
                ? await findQueueMatchForUris(info.uri, info.nextUri || '')
                : null;

            if (match) {
                const playerData = usePlayerStore.getState().getPlayerData();
                const isAlreadyCurrent =
                    playerData.currentSong?._uniqueId === match.matchedSong._uniqueId;
                let trackedUrl = match.matchedUrl;
                try {
                    const fullUrl = await getDlnaUrl(match.matchedSong, transcode);
                    if (fullUrl) trackedUrl = fullUrl;
                } catch {
                    // Fallback
                }

                if (!isAlreadyCurrent) {
                    mediaPlayByIndex?.(match.index);
                }
                if (info.position > 0) setTimestamp(Math.floor(info.position));
                lastSentRawUrlRef.current = trackedUrl;
                lastSentUrlRef.current = trackedUrl;
                lastSentAtRef.current = Date.now();
                wasNearEndRef.current = false;
                mountHandoffInProgressRef.current = false;
                if (playerStatus === PlayerStatus.PLAYING) {
                    if (pendingInitialSeek.value >= 0) {
                        const seekTarget = pendingInitialSeek.value;
                        pendingInitialSeek.value = -1;
                        dlnaPlayer?.seek(seekTarget);
                    }
                    dlnaPlayer?.play();
                } else if (info.transportState === 'PLAYING') {
                    pendingInitialSeek.value = -1;
                    speakerSidePlayRef.current = true;
                    suppressDeviceSeekRef.current = true;
                    mediaPlay?.();
                } else if (
                    info.transportState === 'PAUSED_PLAYBACK' &&
                    usePlayerStore.getState().player.status !== PlayerStatus.PAUSED
                ) {
                    speakerSidePauseRef.current = true;
                    mediaPause?.();
                }
                sendNextTrackToDlna();
                return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            lastSentRawUrlRef.current = '';
            lastSentUrlRef.current = '';
            mountHandoffInProgressRef.current = false;
            if (playerStatus === PlayerStatus.PLAYING) {
                sendCurrentTrackToDlna();
            }
        };
        return dlnaPlayer.on('rendererDlnaConnectPlayback', handler);
    }, [
        transcode,
        setTimestamp,
        playerStatus,
        sendCurrentTrackToDlna,
        sendNextTrackToDlna,
        mediaPlay,
        mediaPlayByIndex,
        mediaPause,
        dlnaPlayer,
        clientKey,
    ]);
    // Send just the next track (for after gapless transition)
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = (state: string) => {
            // Server-authoritative session: transport state pushes arrive
            // via `rendererPlayerState` patches (the `status` field) and
            // are applied by `useDlnaSessionSync`.  This legacy handler
            // would call `mediaPlay`/`mediaPause` and loop.
            if (usePlayerStore.getState().isDlnaMode) return;
            if (devicePassiveModeRef.current) {
                if (state === 'PLAYING') {
                    devicePassiveModeRef.current = false;
                    mediaPlay?.();
                }
                return;
            }
            const msSinceLastSend =
                lastSentAtRef.current === 0 ? Infinity : Date.now() - lastSentAtRef.current;
            if (msSinceLastSend < 2000 && state !== 'PLAYING') return;
            if (state === 'PLAYING') {
                speakerSidePlayRef.current = true;
                mediaPlay?.();
            } else if (state === 'PAUSED_PLAYBACK') {
                speakerSidePauseRef.current = true;
                mediaPause?.();
            } else if (state === 'STOPPED') {
                mediaPause?.();
            }
        };
        return dlnaPlayer.on('rendererDlnaTransportState', handler);
    }, [mediaPlay, mediaPause, dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = () => {
            // Server-authoritative session: prev-track is initiated by the
            // server itself (it owns position polling + track-end detection).
            // The renderer's `mediaPrevious` action also forwards via RPC
            // when `isDlnaMode` is true.  This legacy event handler would
            // double-advance.
            if (usePlayerStore.getState().isDlnaMode) return;
            const timeSinceTrackEnded = Date.now() - recentTrackEndedAtRef.current;
            if (timeSinceTrackEnded < TRACK_ENDED_PREV_SUPPRESSION_MS) {
                return;
            }
            if (sameUriLoopQueuedRef.current && wasNearEndRef.current) {
                sameUriLoopQueuedRef.current = false;
                wasNearEndRef.current = false;
                recentTrackEndedAtRef.current = Date.now();

                const currentSpeed = usePlayerStore.getState().player.speed || 1;
                skipNextSendRef.current = currentSpeed === 1;

                onEnded();
                setTimeout(() => sendNextTrackToDlna(), 200);
                return;
            }
            sameUriLoopQueuedRef.current = false;
            mediaPrevious(false);
        };
        return dlnaPlayer.on('rendererDlnaPrevTrack', handler);
    }, [mediaPrevious, onEnded, sendNextTrackToDlna, dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = (vol: number) => {
            // Device-side volume events (Sonos app, physical knob, poll-detected
            // drift) still arrive on this legacy channel even in
            // server-authoritative mode. The `rendererPlayerState` patch path
            // only fires when the volume change originated from a `setVolume`
            // RPC — device-side changes aren't broadcast as patches, so without
            // this handler the slider in secondary tabs would never move when
            // the user turns the knob outside the app.
            //
            // Write directly to the store (bypassing the `setVolume` action)
            // so we don't re-forward to the server via `sessionSetVolume` and
            // create an echo loop. The engine's `volume` effect below still
            // bails on `isDlnaMode`, so no redundant SOAP command is sent to
            // the device either.
            if (usePlayerStoreBase.getState().applyingRemoteUpdate) return;
            usePlayerStoreBase.setState((s) => {
                s.player.volume = vol;
            });
        };
        return dlnaPlayer.on('rendererDlnaVolume', handler);
    }, [dlnaPlayer, clientKey]);
    // Listen for track ended events
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handleTrackEnded = () => {
            // Server-authoritative session: the server's
            // `startPositionPolling` detects track-end and advances the
            // queue itself (via `session.next()` →
            // `sendCurrentTrackFromSession()`).  It still emits
            // `rendererDlnaTrackEnded` for UI animation cues, but the
            // renderer must NOT call `onEnded()` or `stop()` — the
            // server owns the queue and the device transport.
            if (usePlayerStore.getState().isDlnaMode) return;
            if (!hasPlayedRef.current) return;
            const state = usePlayerStore.getState();
            const playerData = state.getPlayerData();
            const isAtEnd = !playerData.nextSong;
            const isRepeating = state.player.repeat !== 'none';
            if (isAtEnd && !isRepeating) {
                isAutoAdvancingRef.current = false;
                hasPlayedRef.current = false;
                dlnaPlayer.stop();
                onEnded();
                return;
            }
            recentTrackEndedAtRef.current = Date.now();
            sameUriLoopQueuedRef.current = false;
            wasNearEndRef.current = false;
            const currentSpeed = usePlayerStore.getState().player.speed || 1;
            isAutoAdvancingRef.current = true;
            skipNextSendRef.current = currentSpeed === 1;
            onEnded();
            if (currentSpeed !== 1) {
                setTimeout(() => {
                    sendCurrentTrackToDlna();
                }, 200);
            } else {
                setTimeout(() => sendNextTrackToDlna(), 500);
            }
        };
        return dlnaPlayer.on('rendererDlnaTrackEnded', handleTrackEnded);
    }, [onEnded, sendCurrentTrackToDlna, sendNextTrackToDlna, dlnaPlayer, clientKey]);
    // Handle play/pause
    const isInitialMount = useRef(true);
    useEffect(() => {
        if (isInitialMount.current) {
            isInitialMount.current = false;
            return;
        }
        const client = dlnaPlayerRef.current;
        if (!client) return;
        // Server-authoritative session: play/pause forwards via the
        // `sessionSetStatus` RPC (the store action intercepts).  The
        // server issues `play()`/`pause()` to the device and broadcasts
        // a `rendererPlayerState` patch back.  Calling `client.play()` /
        // `sendCurrentTrackToDlna()` here would race with the server.
        if (usePlayerStore.getState().isDlnaMode) return;
        if (devicePassiveModeRef.current) {
            if (playerStatus === PlayerStatus.PAUSED) {
                devicePassiveModeRef.current = false;
                client.pause();
                return;
            }
            if (playerStatus === PlayerStatus.PLAYING) {
                devicePassiveModeRef.current = false;
            } else {
                return;
            }
        }
        const isSpeakerSidePlay = speakerSidePlayRef.current;
        speakerSidePlayRef.current = false;
        const isSpeakerSidePause = speakerSidePauseRef.current;
        speakerSidePauseRef.current = false;
        if (playerStatus === PlayerStatus.PLAYING) {
            if (hasPlayedRef.current) {
                const check = async () => {
                    if (mountHandoffInProgressRef.current) return;
                    const playerData = usePlayerStore.getState().getPlayerData();
                    const currentSong = playerData.currentSong;
                    const currentUrl = currentSong
                        ? await getDlnaUrl(currentSong, transcode)
                        : undefined;
                    if (currentUrl && currentUrl !== lastSentRawUrlRef.current) {
                        skipNextSendRef.current = false;
                        sendCurrentTrackToDlna();
                    } else if (!isSpeakerSidePlay) {
                        if (Date.now() - lastSentAtRef.current > 2000) {
                            client.play();
                        }
                    }
                };
                check();
            } else {
                sendCurrentTrackToDlna();
            }
        } else if (playerStatus === PlayerStatus.PAUSED) {
            if (!isSpeakerSidePause) {
                client.pause();
            }
        }
    }, [playerStatus, transcode, sendCurrentTrackToDlna]);
    // Handle volume
    useEffect(() => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        // Server-authoritative session: volume changes forward via the
        // `setVolume` RPC (the store action intercepts and forwards).
        // Calling `client.volume()` here would race with the server's
        // own volume push.
        if (usePlayerStore.getState().isDlnaMode) return;
        client.volume(volume);
    }, [volume]);
    // Handle mute
    useEffect(() => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        // Server-authoritative session: mute changes forward via the
        // `setMuted` RPC.  Skip the direct `client.mute()` call to avoid
        // racing the server's own mute push.
        if (usePlayerStore.getState().isDlnaMode) return;
        client.mute(isMuted);
    }, [isMuted]);
    usePlayerEvents(
        {
            onMediaNext: () => {
                // Server-authoritative session: next/prev forward via
                // the `sessionNext` RPC (the store action intercepts).
                // Skip the legacy `sendCurrentTrackToDlna` flow — the
                // server issues its own `playUrl`.
                if (usePlayerStore.getState().isDlnaMode) return;
                devicePassiveModeRef.current = false;
                sameUriLoopQueuedRef.current = false;
                wasNearEndRef.current = false;
                skipNextSendRef.current = false;
                sendCurrentTrackToDlna();
            },
            onMediaPrev: () => {
                // Server-authoritative session: see `onMediaNext` above.
                if (usePlayerStore.getState().isDlnaMode) return;
                devicePassiveModeRef.current = false;
                sameUriLoopQueuedRef.current = false;
                wasNearEndRef.current = false;
                skipNextSendRef.current = false;
                sendCurrentTrackToDlna();
            },
            onPlayerPlay: () => {
                if (mountHandoffInProgressRef.current) return;
                if (devicePassiveModeRef.current) return;
                // Server-authoritative session: see `onMediaNext` above.
                if (usePlayerStore.getState().isDlnaMode) return;
                if (justLoadedTrackRef.current) {
                    justLoadedTrackRef.current = false;
                    return;
                }
                skipNextSendRef.current = false;
                sendCurrentTrackToDlna();
            },
            onPlayerSeekToTimestamp: (properties) => {
                if (suppressDeviceSeekRef.current) {
                    suppressDeviceSeekRef.current = false;
                    return;
                }
                // Server-authoritative session: seek forwards via the
                // `seek` RPC; the server issues the SOAP `Seek` to the
                // device and broadcasts a `rendererPlayerState` patch
                // back. Calling `.seek()` here would double-seek.
                if (usePlayerStore.getState().isDlnaMode) return;
                dlnaPlayerRef.current?.seek(properties.timestamp);
            },
            onQueueCleared: () => {
                // Server-authoritative session: the server owns the queue
                // and clears it via the `queueClear` RPC (the store
                // action intercepts and forwards).  Calling `stop()` here
                // would race with the server's own `stop` on disconnect.
                if (usePlayerStore.getState().isDlnaMode) return;
                devicePassiveModeRef.current = false;
                dlnaPlayerRef.current?.stop();
                hasPlayedRef.current = false;
                lastSentUrlRef.current = '';
                lastSentRawUrlRef.current = '';
                sameUriLoopQueuedRef.current = false;
                wasNearEndRef.current = false;
            },
            onQueueRestored: () => {
                // Server-authoritative session: the server owns the queue
                // and will issue its own `playUrl` via
                // `sendCurrentTrackFromSession()` when its queue becomes
                // non-empty.
                if (usePlayerStore.getState().isDlnaMode) return;
                devicePassiveModeRef.current = false;
                sendCurrentTrackToDlna();
            },
        },
        [transcode, sendCurrentTrackToDlna],
    );
    useEffect(() => {
        return usePlayerStore.subscribe(
            (state) => state.player.repeat,
            () => {
                // Server-authoritative session: the server owns the next-track
                // preload and re-evaluates it when its own repeat state
                // changes (via `sessionSetRepeat` → `preloadNextTrack`).
                if (usePlayerStore.getState().isDlnaMode) return;
                if (!hasPlayedRef.current || !dlnaPlayerRef.current) return;
                repeatChangedAtRef.current = Date.now();
                sendNextTrackToDlna();
            },
        );
    }, [sendNextTrackToDlna]);
    useEffect(() => {
        return usePlayerStore.subscribe(
            (state) => state.getPlayerData().nextSong?.id ?? null,
            (nextId, prevId) => {
                // Server-authoritative session: the server preloads the
                // next track itself when its queue/index changes.
                if (usePlayerStore.getState().isDlnaMode) return;
                if (!hasPlayedRef.current || !dlnaPlayerRef.current) return;
                if (nextId === prevId) return;
                sendNextTrackToDlna();
            },
        );
    }, [sendNextTrackToDlna]);
    useEffect(() => {
        return usePlayerStore.subscribe(
            (state) => state.getPlayerData().currentSong?.id ?? null,
            (nextId, prevId) => {
                if (nextId !== prevId) {
                    playerHandoff.pendingDlnaSeek = -1;
                }
                // Server-authoritative session: the server is the source of
                // truth for `currentSong` and issues its own `playUrl` via
                // `sendCurrentTrackFromSession()` when its index changes.
                if (usePlayerStore.getState().isDlnaMode) return;
                if (!hasPlayedRef.current || !dlnaPlayerRef.current) return;
                if (nextId === prevId) return;
                if (mountHandoffInProgressRef.current) return;
                sendCurrentTrackToDlna();
            },
        );
    }, [sendCurrentTrackToDlna]);
    useEffect(() => {
        return usePlayerStore.subscribe(
            (state) => state.player.speed,
            async (newSpeed, oldSpeed) => {
                if (newSpeed === oldSpeed) return;
                // Server-authoritative session: speed changes forward via
                // the `setSpeed` RPC; the server re-prepares the speed
                // transcode file and re-issues `playUrl` itself.
                if (usePlayerStore.getState().isDlnaMode) return;
                if (!hasPlayedRef.current || !dlnaPlayerRef.current) return;

                try {
                    pendingInitialSeek.value = await dlnaPlayerRef.current.getPosition();
                } catch {
                    pendingInitialSeek.value = 0;
                }
                skipNextSendRef.current = false;
                sendCurrentTrackToDlna();
            },
        );
    }, [sendCurrentTrackToDlna]);
    // Handle pitch preservation change
    useEffect(() => {
        return useSettingsStore.subscribe(
            (state) => state.playback.preservePitch,
            async (newPitch, oldPitch) => {
                if (newPitch === oldPitch) return;
                const currentSpeed = usePlayerStore.getState().player.speed || 1;
                if (currentSpeed === 1) return;
                // Server-authoritative session: see speed subscription above.
                if (usePlayerStore.getState().isDlnaMode) return;
                if (!hasPlayedRef.current || !dlnaPlayerRef.current) return;

                try {
                    pendingInitialSeek.value = await dlnaPlayerRef.current.getPosition();
                } catch {
                    pendingInitialSeek.value = 0;
                }
                skipNextSendRef.current = false;
                sendCurrentTrackToDlna();
            },
        );
    }, [sendCurrentTrackToDlna]);
    useImperativeHandle<DlnaPlayerEngineHandle, DlnaPlayerEngineHandle>(playerRef, () => ({
        decreaseVolume(by: number) {
            const newVol = Math.max(0, volume - by);
            dlnaPlayer?.volume(newVol);
        },
        increaseVolume(by: number) {
            const newVol = Math.min(100, volume + by);
            dlnaPlayer?.volume(newVol);
        },
        pause() {
            dlnaPlayer?.pause();
        },
        play() {
            dlnaPlayer?.play();
        },
        seekTo(seconds: number) {
            dlnaPlayer?.seek(seconds);
        },
        setVolume(vol: number) {
            dlnaPlayer?.volume(vol);
        },
    }));
    return <div id="dlna-player-engine" style={{ display: 'none' }} />;
};

DlnaPlayerEngine.displayName = 'DlnaPlayerEngine';
