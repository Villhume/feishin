import type { CastPlayerState, CastQueueSnapshot, CastQueueSong } from '/@/shared/types/cast-types';

/**
 * Subscribes to server-authoritative queue/player state events and applies
 * them to the renderer's player store as "remote updates".
 *
 * Lifecycle:
 *   - `useDlnaSessionSync(client)` is mounted once in `audio-players.tsx`.
 *   - When `client` is a WS client (`isWsClient === true`), the hook
 *     subscribes to `rendererQueueState` (full snapshot) and
 *     `rendererPlayerState` (partial patches) events.
 *   - While applying a remote update, `applyingRemoteUpdate` is set true so
 *     that store actions (e.g. `mediaNext`, `setVolume`) don't re-forward
 *     the same action to the server (avoiding an infinite loop).
 *   - On unmount or client change, all subscriptions are cleaned up.
 *
 * Why a hook and not a one-shot side effect:
 *   - The client object can change (connect/disconnect/reconnect), so the hook
 *     re-subscribes whenever `client` changes.
 *   - The hook is mounted in the main player tree, where it has access to
 *     the `WsDlnaClient` from context.
 *
 * `enqueueWithResolvedUrls` (exported below) is the queue-add entrypoint
 * for DLNA mode:  it pre-resolves stream URLs / album art / MIME types
 * before forwarding via `queueAdd`.  The server has no Navidrome API
 * client, so it can't resolve these itself — the renderer must do it.
 * In non-DLNA mode it delegates to the legacy `addToQueueByData` store
 * function (local mutation path).
 */
import { useEffect } from 'react';

import type { WsDlnaClient } from './dlna-ws-client';

import { api } from '/@/renderer/api';
import {
    getDlnaUrl,
    resolveMimeType,
    type SongWithAudioMeta,
} from '/@/renderer/features/player/audio-player/engine/dlna-player-engine';
import {
    addToQueueByData,
    type AddToQueueType,
    getSessionRpcSender,
    toQueueSong,
    uniqueSeekToTimestamp,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { TranscodingConfig, useSettingsStore } from '/@/renderer/store/settings.store';
import { logger } from '/@/renderer/utils/logger';
import { LibraryItem, QueueSong, Song } from '/@/shared/types/domain-types';
import { Play, PlayerStatus } from '/@/shared/types/types';

/**
 * Reset `applyingRemoteUpdate` on the next macrotask. Using `setTimeout(0)`
 * instead of `queueMicrotask` widens the guard window from "before the next
 * microtask" to "before the next task" — that extra delay covers React's
 * commit phase (which runs on a task via React's scheduler, not a microtask),
 * so engine mount effects that fire during commit see the guard still up
 * and don't echo store mutations back to the server.
 *
 * The window is ~one task (~4ms), imperceptible to users but sufficient to
 * prevent the echo loops and snapshot stomping that broke cross-tab sync.
 */
function withRemoteUpdate<T>(fn: () => T): T {
    usePlayerStoreBase.setState({ applyingRemoteUpdate: true });
    try {
        return fn();
    } finally {
        setTimeout(() => {
            usePlayerStoreBase.setState({ applyingRemoteUpdate: false });
        }, 0);
    }
}

let lastSeenSeekTo = -1;

/**
 *  Queue-add entrypoint for DLNA mode.  When `isDlnaMode` is on, this
 *  pre-resolves stream URLs / album art / MIME types for each song
 *  before forwarding the add via the `queueAdd` RPC.  The server has no
 *  Navidrome API client, so it can't resolve these itself — the renderer
 *  must do it.  In non-DLNA mode it delegates to the legacy
 *  `addToQueueByData` store function (local mutation path, which then
 *  fires `sendCurrentTrackToDlna` via the existing engine subscriptions).
 *
 *  The signature matches `player-context.tsx`'s `addToQueueByData(data,
 *  type, playSongId, ...)`: `data` is first, `type` second.  This lets
 *  us drop the helper in as a drop-in replacement.
 *
 *  Resolution is done in parallel across all songs via `Promise.all`.
 *  For very large bulk adds (e.g. "Play all" on a 3,000-song library),
 *  this spawns 3,000 HEAD requests — the `isOpusByMetadata` short-
 *  circuit inside `getDlnaUrl` skips the probe for obvious OPUS codes,
 *  but ambiguous cases still hit the network.  The progress toast /
 *  confirmation modal in `player-context.tsx` gates this case upstream.
 */
export async function enqueueWithResolvedUrls(
    data: Song[],
    type: AddToQueueType,
    playSongId?: string,
): Promise<void> {
    // Non-DLNA mode: delegate to the legacy store function, which does
    // the local mutation + `sendCurrentTrackToDlna` flow via the engine.
    if (!usePlayerStoreBase.getState().isDlnaMode) {
        return addToQueueByData(type, data);
    }

    const sender = getSessionRpcSender();
    if (!sender || !sender.isWsClient) {
        // WS dropped mid-call: fall back to local mutation so the queue
        // at least updates in the UI.  The engine's `isDlnaMode` gate
        // will skip device commands until the WS reconnects.
        return addToQueueByData(type, data);
    }

    // Resolution path.  Notes:
    //  - `playType` is derived from `type` the same way the store does:
    //    if `type` is a `Play` enum value (string), use it verbatim;
    //    otherwise (object form with `uniqueId`/`edge`) the "play" is
    //    implicit (NEXT) — the server inserts at the target and advances.
    //    The server's `queueAdd` expects a single `playType`, so for the
    //    edge form we pass `Play.NEXT` (matches the renderer's
    //    `addToQueueByUniqueId` behavior when `playSongId` is given).
    //  - For the object form, we also pass `playSongId` separately so
    //    the server can locate the target song by id after insertion.
    const transcode = useSettingsStore.getState().playback.transcode;

    const resolvedSongs = await Promise.all(data.map((song) => resolveQueueSong(song, transcode)));

    if (typeof type === 'string') {
        await sender.queueAdd(resolvedSongs, type, playSongId);
        return;
    }

    // Object form `{ uniqueId, edge }`: the server's `queueAdd` doesn't
    // take a target uniqueId — it always appends/inserts next.  The
    // server's session index will already match the renderer's, so
    // inserting "next" lines up correctly.  Pass `Play.NEXT` and let
    // the server's `DlnaSessionState.add(items, NEXT, ...)` handle the
    // edge case of "play this specific song next" via `playSongId`.
    await sender.queueAdd(resolvedSongs, Play.NEXT, playSongId);
}

/**
 *  Resolve the stream URL, album art URL, and MIME type for a single
 *  `QueueSong` (preserving its existing `_uniqueId`) in the way the DLNA
 *  engine's `sendCurrentTrackToDlna` does it:
 *  - `getDlnaUrl` handles OPUS detection + transcode-to-MP3 fallback.
 *  - `api.controller.getImageUrl` builds a Navidrome album-art URL.
 *  - `resolveMimeType` does a metadata check, with a HEAD probe fallback
 *    for `audio/mpeg` (where the extension is ambiguous).
 *
 *  Returns a `CastQueueSong` with the resolved fields populated — the
 *  server uses these verbatim when it calls `playUrl` on the device.
 *  On resolution failure the fields are left `undefined`, which the
 *  server treats as "use the song's `streamUrl` + suffix-derived MIME"
 *  fallback.  Does NOT throw.
 *
 *  Used by both `enqueueWithResolvedUrls` (queue-add) and
 *  `handoffQueueToServer` (initial cast).  Preserves the existing
 *  `_uniqueId` so the server's queue indices line up with the
 *  renderer's — critical for the handoff case where the queue is
 *  already populated and the server must not re-key entries.
 */
export async function resolveQueueSongUrls(
    queueSong: QueueSong,
    transcode: TranscodingConfig,
): Promise<CastQueueSong> {
    let resolvedStreamUrl: string | undefined;
    try {
        resolvedStreamUrl = await getDlnaUrl(queueSong, transcode);
    } catch (err) {
        logger.warn('[DLNA] failed to resolve stream URL for queue-add', {
            err,
            songId: queueSong.id,
        });
    }

    let resolvedAlbumArtUrl: string | undefined;
    try {
        resolvedAlbumArtUrl =
            api.controller.getImageUrl({
                apiClientProps: { serverId: queueSong._serverId },
                query: {
                    id: queueSong.albumId || queueSong.id,
                    itemType: LibraryItem.ALBUM,
                    size: 600,
                },
            }) || undefined;
    } catch {
        // Ignore image URL errors — not all songs have album art.
    }

    let resolvedMimeType: string | undefined;
    if (resolvedStreamUrl) {
        try {
            const { contentType, suffix } = queueSong as unknown as SongWithAudioMeta;
            resolvedMimeType = await resolveMimeType(resolvedStreamUrl, contentType, suffix);
        } catch {
            // Leave undefined — server falls back to suffix-derived MIME.
        }
    }

    return {
        ...queueSong,
        resolvedAlbumArtUrl,
        resolvedMimeType,
        resolvedStreamUrl,
    };
}

/**
 * Hook entrypoint. Call from a single mount point in the app.
 */
export function useDlnaSessionSync(client: null | WsDlnaClient): void {
    useEffect(() => {
        if (!client || !client.isWsClient) {
            return;
        }

        logger.debug('[DLNA Session] mounting session-sync subscriptions');

        const offQueue = client.on('rendererQueueState', (payload) => {
            applyQueueState(payload);
        });
        const offPlayer = client.on('rendererPlayerState', (payload) => {
            applyPlayerPatch(payload);
        });

        return () => {
            offQueue();
            offPlayer();
            logger.debug('[DLNA Session] unmounting session-sync subscriptions');
        };
    }, [client]);
}

/**
 * Apply a `rendererPlayerState` patch. The patch is a partial
 * `CastPlayerState` — only touched keys should be written.
 */
function applyPlayerPatch(patch: Partial<CastPlayerState>): void {
    withRemoteUpdate(() => {
        usePlayerStoreBase.setState((s) => {
            if (patch.status !== undefined) {
                s.player.status = patch.status;
            }
            if (patch.repeat !== undefined) {
                s.player.repeat = patch.repeat;
            }
            if (patch.shuffle !== undefined) {
                s.player.shuffle = patch.shuffle;
            }
            if (patch.speed !== undefined) {
                s.player.speed = patch.speed;
            }
            if (patch.volume !== undefined) {
                s.player.volume = patch.volume;
            }
            if (patch.muted !== undefined) {
                s.player.muted = patch.muted;
            }
            if (patch.index !== undefined) {
                s.player.index = patch.index;
            }
            if (patch.seekTo !== undefined && patch.seekTo >= 0) {
                // The store has two seek concepts: `seekToTimestamp` (for the
                // engine to seek on the active track) and the timestamp
                // store (for the progress bar / time display). Drive both
                // so the UI reflects the seek immediately on next render.
                // `uniqueSeekToTimestamp` adds a nanoid suffix so Zustand's
                // equality check fires even when the same seek position is
                // requested twice (the consumer in player.store.ts parses
                // the suffix off before use).
                if (patch.seekTo !== lastSeenSeekTo) {
                    s.player.seekToTimestamp = uniqueSeekToTimestamp(patch.seekTo);
                    lastSeenSeekTo = patch.seekTo;
                }
            } else if (patch.status === PlayerStatus.STOPPED) {
                // Reset timestamp when stopped so the progress bar lands on 0.
                s.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                lastSeenSeekTo = -1;
            }
        });
    });
}

/**
 * Apply a `rendererQueueState` snapshot — replaces the full queue + player
 * state. This is the authoritative state from the server.
 */
function applyQueueState(snapshot: { player: CastPlayerState; queue: CastQueueSnapshot }): void {
    withRemoteUpdate(() => {
        usePlayerStoreBase.setState((s) => {
            s.queue = {
                default: snapshot.queue.default,
                shuffled: snapshot.queue.shuffled,
                songs: snapshot.queue.songs,
            };
            s.player.index = snapshot.player.index;
            s.player.status = snapshot.player.status;
            s.player.repeat = snapshot.player.repeat;
            s.player.shuffle = snapshot.player.shuffle;
            s.player.speed = snapshot.player.speed;
            s.player.volume = snapshot.player.volume;
            s.player.muted = snapshot.player.muted;
            if (snapshot.player.seekTo >= 0) {
                s.player.seekToTimestamp = uniqueSeekToTimestamp(snapshot.player.seekTo);
                lastSeenSeekTo = snapshot.player.seekTo;
            }
        });
    });
}

/**
 *  Resolve a `Song` (not yet a `QueueSong`) into a `CastQueueSong`.
 *  Generates a fresh `_uniqueId` via `toQueueSong` — used only by the
 *  queue-add path where new songs are being inserted.  For handoff
 *  (initial cast with an existing queue), use `resolveQueueSongUrls`
 *  directly to preserve existing `_uniqueId`s.
 */
async function resolveQueueSong(song: Song, transcode: TranscodingConfig): Promise<CastQueueSong> {
    const queueSong: QueueSong = toQueueSong(song);
    return resolveQueueSongUrls(queueSong, transcode);
}
