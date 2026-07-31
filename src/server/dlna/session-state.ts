/**
 *  Server-side authoritative queue + player state for DLNA sessions.
 *
 *  PORT OF `src/renderer/store/player.store.ts` queue/index/shuffle logic.
 *  Keep in sync with the renderer's logic — any divergence will cause
 *  state desync between the server and the local (legacy) Electron IPC
 *  path, which still uses the renderer's store as the source of truth.
 *
 *  This class is intentionally pure (no EventEmitter, no I/O).  The
 *  controller (`DlnaController`) owns an instance and is responsible
 *  for:
 *    - Mutating state via these methods.
 *    - Re-issuing `playUrl` to the device after track-changing RPCs.
 *    - Broadcasting `rendererQueueState` / `rendererPlayerState` events
 *      to all connected WS clients so the renderer tabs stay in sync.
 *
 *  The methods mirror the renderer's player-store actions
 *  (`mediaNext`, `mediaPrevious`, `addToQueueByType`, `setShuffle`, …)
 *  one-for-one where possible.  Differences:
 *    - No `immer` — direct mutation under a single `state` field.
 *    - No event emission (controller layer's job).
 *    - `seekTo` is a wall-clock seconds number, not a unique-stamped
 *      string.  The controller converts to the unique-stamped form when
 *      broadcasting so the renderer's `seekToTimestamp` subscription
 *      fires (the stamp guarantees dedupe).
 */
import type {
    CastPlayerState,
    CastQueueSnapshot,
    CastQueueSong,
} from '/@/shared/types/cast-types';
import { Play, PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

// ---------------------------------------------------------------------------
// Pure helpers (ported from src/renderer/store/player.store.ts)
// ---------------------------------------------------------------------------

const randomBuffer = new Uint32Array(1);

function cryptoRandom(): number {
    crypto.getRandomValues(randomBuffer);
    return randomBuffer[0] / 0x100000000;
}

function shuffleInPlace<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(cryptoRandom() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function isShuffleEnabled(state: { player: { shuffle: PlayerShuffle }; queue: { shuffled: number[] } }): boolean {
    return state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0;
}

function generateShuffledIndexes(length: number): number[] {
    const indexes = Array.from({ length }, (_, i) => i);
    return shuffleInPlace(indexes);
}

/**
 *  Port of `calculateNextIndex` (player.store.ts L204-229).  Returns
 *  the next playback index and whether the queue should stop (i.e.
 *  last track with no repeat).
 */
function calculateNextIndex(
    currentIndex: number,
    queueLength: number,
    repeat: PlayerRepeat,
): { nextIndex: number; shouldStop: boolean } {
    const isLastTrack = currentIndex === queueLength - 1;
    if (repeat === PlayerRepeat.ONE) {
        return { nextIndex: currentIndex, shouldStop: false };
    }
    if (repeat === PlayerRepeat.ALL) {
        if (isLastTrack) return { nextIndex: 0, shouldStop: false };
        return { nextIndex: currentIndex + 1, shouldStop: false };
    }
    if (isLastTrack) return { nextIndex: currentIndex, shouldStop: true };
    return { nextIndex: currentIndex + 1, shouldStop: false };
}

/**
 *  Port of `calculatePreviousIndex` — mirrors the renderer's
 *  `mediaPrevious(toPreviousAlbum)` simplified to the common case
 *  (no album-jump, just single-track back with wrap on `repeat=all`).
 */
function calculatePreviousIndex(
    currentIndex: number,
    queueLength: number,
    repeat: PlayerRepeat,
): number {
    if (currentIndex <= 0) {
        if (repeat === PlayerRepeat.ALL) return queueLength - 1;
        return 0;
    }
    return currentIndex - 1;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface SessionState {
    queue: {
        default: string[];
        shuffled: number[];
        songs: Record<string, CastQueueSong>;
    };
    player: {
        index: number;
        status: PlayerStatus;
        repeat: PlayerRepeat;
        shuffle: PlayerShuffle;
        speed: number;
        volume: number;
        muted: boolean;
        seekTo: number; // -1 = no pending seek
    };
}

const initialState: SessionState = {
    player: {
        index: -1,
        muted: false,
        repeat: PlayerRepeat.NONE,
        seekTo: -1,
        shuffle: PlayerShuffle.NONE,
        speed: 1,
        status: PlayerStatus.PAUSED,
        volume: 30,
    },
    queue: {
        default: [],
        shuffled: [],
        songs: {},
    },
};

// Result of an index-changing operation — tells the controller whether
// to issue `playUrl` to the device, plus the new song to play.
export interface TrackChangeResult {
    /** Whether the queueIndexChanged (e.g. next, previous, play-by-index). */
    changed: boolean;
    /** The song (if any) that should now be playing on the device. */
    song: CastQueueSong | undefined;
    /** Whether playback reached the end (queue should stop). */
    shouldStop: boolean;
}

// ---------------------------------------------------------------------------
// DlnaSessionState
// ---------------------------------------------------------------------------

export class DlnaSessionState {
    private state: SessionState = JSON.parse(JSON.stringify(initialState));

    /** Reset to empty. Called when DLNA session is torn down. */
    reset(): void {
        this.state = JSON.parse(JSON.stringify(initialState));
    }

    /** Replace the entire queue + optionally patch player state. Port
     *  of the renderer's `setQueue` action (player.store.ts L1467). */
    setQueue(queue: CastQueueSnapshot, playerPatch?: Partial<CastPlayerState>): void {
        this.state.queue = {
            default: [...queue.default],
            shuffled: [...queue.shuffled],
            songs: { ...queue.songs },
        };
        if (playerPatch) {
            if (playerPatch.index !== undefined) this.state.player.index = playerPatch.index;
            if (playerPatch.status !== undefined) this.state.player.status = playerPatch.status;
            if (playerPatch.repeat !== undefined) this.state.player.repeat = playerPatch.repeat;
            if (playerPatch.shuffle !== undefined) this.state.player.shuffle = playerPatch.shuffle;
            if (playerPatch.speed !== undefined) this.state.player.speed = playerPatch.speed;
            if (playerPatch.volume !== undefined) this.state.player.volume = playerPatch.volume;
            if (playerPatch.muted !== undefined) this.state.player.muted = playerPatch.muted;
            if (playerPatch.seekTo !== undefined && playerPatch.seekTo >= 0) {
                this.state.player.seekTo = playerPatch.seekTo;
            }
        }
    }

    /**
     *  Port of `addToQueueByType` (player.store.ts L359+) for the
     *  server-side session.  Only the Play.NOW / NEXT / LAST cases
     *  are ported; SHUFFLE variants reduce to "shuffle all after
     *  insert."  Returns whether the current song changed (and thus
     *  the controller should issue playUrl).
     */
    add(items: CastQueueSong[], playType: Play, playSongId?: string): TrackChangeResult {
        if (items.length === 0) return { changed: false, shouldStop: false, song: this.getCurrentSong() };
        const newUniqueIds = items.map((s) => s._uniqueId);
        const newSongs: Record<string, CastQueueSong> = {};
        for (const s of items) newSongs[s._uniqueId] = s;
        Object.assign(this.state.queue.songs, newSongs);

        switch (playType) {
            case Play.NOW: {
                this.state.queue.default = newUniqueIds;
                this.state.player.index = 0;
                this.state.player.status = PlayerStatus.PLAYING;
                if (isShuffleEnabled(this.state)) {
                    this.state.queue.shuffled = generateShuffledIndexes(this.state.queue.default.length);
                    // If asked to start on a specific song, place it first
                    if (playSongId && newUniqueIds.includes(playSongId)) {
                        const songIndex = newUniqueIds.indexOf(playSongId);
                        const shuffledPosition = this.state.queue.shuffled.indexOf(songIndex);
                        if (shuffledPosition > 0) {
                            // swap to front
                            [this.state.queue.shuffled[0], this.state.queue.shuffled[shuffledPosition]] = [
                                this.state.queue.shuffled[shuffledPosition],
                                this.state.queue.shuffled[0],
                            ];
                        }
                        this.state.player.index = 0;
                    }
                } else if (playSongId && newUniqueIds.includes(playSongId)) {
                    this.state.player.index = newUniqueIds.indexOf(playSongId);
                }
                this.state.player.seekTo = 0;
                return { changed: true, shouldStop: false, song: this.getCurrentSong() };
            }
            case Play.NEXT: {
                const playOrder = this.getPlaybackOrderIndexes();
                const currentPos = this.state.player.index;
                const insertAtDefault =
                    currentPos >= 0 ? playOrder[currentPos] + 1 : this.state.queue.default.length;
                this.state.queue.default.splice(insertAtDefault, 0, ...newUniqueIds);
                // Re-shuffle the tail to keep the rest random — port of addIndexesToShuffled
                if (isShuffleEnabled(this.state)) {
                    // After inserting at `insertAtDefault`, adjust existing shuffled indexes
                    this.state.queue.shuffled = this.state.queue.shuffled.map((idx) =>
                        idx >= insertAtDefault ? idx + items.length : idx,
                    );
                    const newIndexes = Array.from({ length: items.length }, (_, i) => insertAtDefault + i);
                    const beforeCurrent = this.state.queue.shuffled.slice(0, currentPos + 1);
                    const afterCurrent = this.state.queue.shuffled.slice(currentPos + 1);
                    const toShuffle = [...afterCurrent, ...newIndexes];
                    this.state.queue.shuffled = [...beforeCurrent, ...shuffleInPlace(toShuffle)];
                }
                return { changed: false, shouldStop: false, song: this.getCurrentSong() };
            }
            case Play.LAST: {
                this.state.queue.default.push(...newUniqueIds);
                if (isShuffleEnabled(this.state)) {
                    const base = this.state.queue.default.length - newUniqueIds.length;
                    const newIndexes = newUniqueIds.map((_, i) => base + i);
                    this.state.queue.shuffled.push(...shuffleInPlace(newIndexes));
                }
                return { changed: false, shouldStop: false, song: this.getCurrentSong() };
            }
            case Play.SHUFFLE:
            case Play.LAST_SHUFFLE:
            case Play.NEXT_SHUFFLE: {
                // Treat SHUFFLE as: replace queue + shuffle + play from a random song
                this.state.queue.default = newUniqueIds;
                this.state.player.shuffle = PlayerShuffle.TRACK;
                this.state.queue.shuffled = generateShuffledIndexes(newUniqueIds.length);
                this.state.player.index = 0;
                this.state.player.status = PlayerStatus.PLAYING;
                this.state.player.seekTo = 0;
                return { changed: true, shouldStop: false, song: this.getCurrentSong() };
            }
            case Play.INDEX: {
                this.state.queue.default = newUniqueIds;
                if (playSongId && newUniqueIds.includes(playSongId)) {
                    this.state.player.index = newUniqueIds.indexOf(playSongId);
                } else {
                    this.state.player.index = 0;
                }
                this.state.player.status = PlayerStatus.PLAYING;
                this.state.player.seekTo = 0;
                return { changed: true, shouldStop: false, song: this.getCurrentSong() };
            }
            default:
                return { changed: false, shouldStop: false, song: this.getCurrentSong() };
        }
    }

    remove(uniqueIds: string[]): void {
        const toRemove = new Set(uniqueIds);
        const currentUniqueId = this.getCurrentSong()?._uniqueId;
        // Remove from songs
        for (const id of uniqueIds) delete this.state.queue.songs[id];
        // Rebuild default without removed entries
        const newDefault: string[] = [];
        const oldToNewIndex = new Map<number, number>(); // old default idx -> new
        for (let oldIdx = 0; oldIdx < this.state.queue.default.length; oldIdx++) {
            const id = this.state.queue.default[oldIdx];
            if (toRemove.has(id)) continue;
            oldToNewIndex.set(oldIdx, newDefault.length);
            newDefault.push(id);
        }
        this.state.queue.default = newDefault;
        // Rebuild shuffled array
        if (this.state.queue.shuffled.length > 0) {
            const newShuffled: number[] = [];
            for (const oldIdx of this.state.queue.shuffled) {
                const newIdx = oldToNewIndex.get(oldIdx);
                if (newIdx !== undefined) newShuffled.push(newIdx);
            }
            this.state.queue.shuffled = newShuffled;
        }
        // Fix up player.index — if the current song was removed, pick the
        // next one; if queue is empty, set to -1.
        if (currentUniqueId && toRemove.has(currentUniqueId)) {
            // pick the same index position (now pointing to the next song)
            if (newDefault.length === 0) {
                this.state.player.index = -1;
                this.state.player.status = PlayerStatus.STOPPED;
            } else if (this.state.player.index >= newDefault.length) {
                this.state.player.index = newDefault.length - 1;
            }
        } else if (currentUniqueId) {
            // Find the still-present current song's position in the new order
            const oldIdx = this.state.queue.default.indexOf(currentUniqueId);
            // In shuffled mode, find the position in shuffled
            if (isShuffleEnabled(this.state)) {
                const shuffledPos = this.state.queue.shuffled.indexOf(oldIdx);
                this.state.player.index = shuffledPos >= 0 ? shuffledPos : this.state.player.index;
            } else {
                this.state.player.index = oldIdx >= 0 ? oldIdx : this.state.player.index;
            }
        }
        if (this.state.player.index < 0 && newDefault.length > 0) {
            this.state.player.index = 0;
        }
    }

    move(uniqueIds: string[], targetUniqueId: string, edge: 'bottom' | 'top'): void {
        const toMove = new Set(uniqueIds);
        if (!this.state.queue.songs[targetUniqueId]) return;
        const defaultArr = this.state.queue.default;
        const moved: string[] = [];
        const remaining: string[] = [];
        for (const id of defaultArr) {
            if (toMove.has(id)) moved.push(id);
            else remaining.push(id);
        }
        const targetPos = remaining.indexOf(targetUniqueId);
        if (targetPos < 0) {
            // target was in moved set — just append
            this.state.queue.default = [...remaining, ...moved];
        } else if (edge === 'top') {
            this.state.queue.default = [
                ...remaining.slice(0, targetPos),
                ...moved,
                ...remaining.slice(targetPos),
            ];
        } else {
            this.state.queue.default = [
                ...remaining.slice(0, targetPos + 1),
                ...moved,
                ...remaining.slice(targetPos + 1),
            ];
        }
        // Shuffled holds indexes into `default`.  When default's order
        // changes via a move, the same shuffled indexes now point to
        // different songs.  Cheapest correct fix is to re-shuffle the new
        // default order from scratch (preserving the current song at index 0).
        if (this.state.queue.shuffled.length > 0) {
            this.state.queue.shuffled = generateShuffledIndexes(this.state.queue.default.length);
            const currentSong = this.getCurrentSong();
            if (currentSong) {
                const currentDefaultIdx = this.state.queue.default.indexOf(currentSong._uniqueId);
                const currentShuffledPos = this.state.queue.shuffled.indexOf(currentDefaultIdx);
                if (currentShuffledPos > 0) {
                    [this.state.queue.shuffled[0], this.state.queue.shuffled[currentShuffledPos]] = [
                        this.state.queue.shuffled[currentShuffledPos],
                        this.state.queue.shuffled[0],
                    ];
                }
            }
            this.state.player.index = 0;
        }
    }

    clear(): void {
        this.state.queue.default = [];
        this.state.queue.shuffled = [];
        this.state.queue.songs = {};
        this.state.player.index = -1;
        this.state.player.status = PlayerStatus.STOPPED;
    }

    shuffleAll(): void {
        this.state.player.shuffle = PlayerShuffle.TRACK;
        if (this.state.queue.default.length > 0) {
            this.state.queue.shuffled = generateShuffledIndexes(this.state.queue.default.length);
            // Keep the current song at index 0 in the new shuffle
            const currentSong = this.getCurrentSong();
            if (currentSong) {
                const currentDefaultIdx = this.state.queue.default.indexOf(currentSong._uniqueId);
                const currentShuffledPos = this.state.queue.shuffled.indexOf(currentDefaultIdx);
                if (currentShuffledPos > 0) {
                    [this.state.queue.shuffled[0], this.state.queue.shuffled[currentShuffledPos]] = [
                        this.state.queue.shuffled[currentShuffledPos],
                        this.state.queue.shuffled[0],
                    ];
                }
            }
            this.state.player.index = 0;
        }
    }

    /**
     *  Port of `mediaAutoNext` (player.store.ts L925).  Used when the
     *  device signals track-end.  Returns whether the index changed
     *  (and thus the controller should issue playUrl for the new song)
     *  and whether the queue should stop.
     */
    next(_toNextAlbum?: boolean): TrackChangeResult {
        const playOrder = this.getPlaybackOrderIndexes();
        if (playOrder.length === 0) {
            return { changed: false, shouldStop: true, song: undefined };
        }
        const currentIndex = this.state.player.index;
        const { nextIndex, shouldStop } = calculateNextIndex(
            currentIndex,
            playOrder.length,
            this.state.player.repeat,
        );
        if (shouldStop) {
            this.state.player.status = PlayerStatus.STOPPED;
            return { changed: false, shouldStop: true, song: undefined };
        }
        this.state.player.index = nextIndex;
        this.state.player.status = PlayerStatus.PLAYING;
        this.state.player.seekTo = 0;
        return { changed: true, shouldStop: false, song: this.getCurrentSong() };
    }

    previous(_toPreviousAlbum?: boolean): TrackChangeResult {
        const playOrder = this.getPlaybackOrderIndexes();
        if (playOrder.length === 0) {
            return { changed: false, shouldStop: false, song: undefined };
        }
        const currentIndex = this.state.player.index;
        this.state.player.index = calculatePreviousIndex(
            currentIndex,
            playOrder.length,
            this.state.player.repeat,
        );
        this.state.player.status = PlayerStatus.PLAYING;
        this.state.player.seekTo = 0;
        return { changed: true, shouldStop: false, song: this.getCurrentSong() };
    }

    playByIndex(index: number): TrackChangeResult {
        const playOrder = this.getPlaybackOrderIndexes();
        if (index < 0 || index >= playOrder.length) {
            return { changed: false, shouldStop: false, song: this.getCurrentSong() };
        }
        this.state.player.index = index;
        this.state.player.status = PlayerStatus.PLAYING;
        this.state.player.seekTo = 0;
        return { changed: true, shouldStop: false, song: this.getCurrentSong() };
    }

    playByUniqueId(uniqueId: string): TrackChangeResult {
        const defaultIdx = this.state.queue.default.indexOf(uniqueId);
        if (defaultIdx < 0) {
            return { changed: false, shouldStop: false, song: this.getCurrentSong() };
        }
        let pos: number;
        if (isShuffleEnabled(this.state)) {
            pos = this.state.queue.shuffled.indexOf(defaultIdx);
            if (pos < 0) pos = 0;
        } else {
            pos = defaultIdx;
        }
        return this.playByIndex(pos);
    }

    setStatus(status: PlayerStatus): void {
        this.state.player.status = status;
    }

    setRepeat(repeat: PlayerRepeat): void {
        this.state.player.repeat = repeat;
    }

    setShuffle(shuffle: PlayerShuffle): void {
        if (shuffle === PlayerShuffle.TRACK && this.state.player.shuffle !== PlayerShuffle.TRACK) {
            this.shuffleAll();
        } else if (shuffle !== PlayerShuffle.TRACK) {
            // Turning off shuffle — preserve current song, reset index to
            // its position in default order.
            const currentSong = this.getCurrentSong();
            this.state.player.shuffle = shuffle;
            if (currentSong) {
                const defaultIdx = this.state.queue.default.indexOf(currentSong._uniqueId);
                if (defaultIdx >= 0) this.state.player.index = defaultIdx;
            }
            this.state.queue.shuffled = [];
        }
    }

    setSpeed(speed: number): void {
        this.state.player.speed = speed;
    }

    setVolume(volume: number): void {
        this.state.player.volume = Math.max(0, Math.min(100, volume));
    }

    setMuted(muted: boolean): void {
        this.state.player.muted = muted;
    }

    seek(seconds: number): void {
        this.state.player.seekTo = Math.max(0, seconds);
    }

    /** Returns the queue in playback order (shuffled if shuffle is on). */
    getPlaybackOrderIndexes(): number[] {
        if (isShuffleEnabled(this.state) && this.state.queue.shuffled.length > 0) {
            return this.state.queue.shuffled;
        }
        return this.state.queue.default.map((_, i) => i);
    }

    /** Returns the song at the current playback index, or undefined. */
    getCurrentSong(): CastQueueSong | undefined {
        const playOrder = this.getPlaybackOrderIndexes();
        const idx = this.state.player.index;
        if (idx < 0 || idx >= playOrder.length) return undefined;
        const defaultIdx = playOrder[idx];
        const uniqueId = this.state.queue.default[defaultIdx];
        return uniqueId ? this.state.queue.songs[uniqueId] : undefined;
    }

    /** Returns the next song (with respect to repeat), or undefined. */
    getNextSong(): CastQueueSong | undefined {
        const playOrder = this.getPlaybackOrderIndexes();
        const idx = this.state.player.index;
        const { nextIndex } = calculateNextIndex(idx, playOrder.length, this.state.player.repeat);
        if (nextIndex < 0 || nextIndex >= playOrder.length) return undefined;
        const defaultIdx = playOrder[nextIndex];
        const uniqueId = this.state.queue.default[defaultIdx];
        return uniqueId ? this.state.queue.songs[uniqueId] : undefined;
    }

    /** Returns the song that would be `next` in logical playback order
     *  (NULL if the queue is empty or only has one song).  Used for
     *  `setNextUrl` gapless pre-loading. */
    peekNextSong(): CastQueueSong | undefined {
        return this.getNextSong();
    }

    snapshot(): { player: CastPlayerState; queue: CastQueueSnapshot } {
        return {
            player: { ...this.state.player },
            queue: {
                default: [...this.state.queue.default],
                shuffled: [...this.state.queue.shuffled],
                songs: { ...this.state.queue.songs },
            },
        };
    }

    /** A small patch describing only the player fields, for efficient
     *  `rendererPlayerState` broadcasts (vs. full `rendererQueueState`). */
    playerPatch(): Partial<CastPlayerState> {
        return { ...this.state.player };
    }

    /** Current queue length (in playback order). */
    get queueLength(): number {
        return this.getPlaybackOrderIndexes().length;
    }

    /** True if the queue is empty. */
    get isEmpty(): boolean {
        return this.state.queue.default.length === 0;
    }
}
