import type { CastSettings } from '/@/renderer/store';
import type { ReactNode } from 'react';

/**
 * React context provider that exposes a single `DlnaClient | null` to the
 * renderer. The client is selected based on environment and settings:
 *
 *   1. If `isElectron()` and `cast.mode !== 'off'`: return an
 *      `ElectronDlnaClient` wrapping `window.api`. Zero behavior change.
 *
 *   2. Otherwise if `cast.mode === 'off'`: return null (DLNA disabled).
 *
 *   3. Otherwise (web/Docker + auto or manual): build the list of candidate
 *      server URLs, probe each via HTTP `/health` to rank by latency, then
 *      return the first `WsDlnaClient` that successfully completes the
 *      `hello` handshake. On disconnect, retry with exponential backoff.
 *      Reconnects reuse the original probed order (no re-probe per retry).
 *
 * The client is replaced (not mutated) when settings change in a way that
 * requires a new connection (different URL list, different auth token, or
 * mode flip). Listeners installed via `client.on(...)` need to be
 * re-registered by the consumer after a client swap — the provider surfaces
 * `clientKey` for that purpose (it changes whenever the client is replaced).
 */
import isElectron from 'is-electron';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type { DlnaClient } from './dlna-client';

import { createElectronDlnaClient } from './dlna-electron-client';
import { WsDlnaClient } from './dlna-ws-client';

import { castSessionActions } from '/@/renderer/features/player/api/cast-session-store';
import { playerHandoff } from '/@/renderer/features/player/audio-player/engine/player-handoff';
import { useCastSettings, usePlayerStoreBase, useSettingsStore } from '/@/renderer/store';
import { setSessionRpcSender, uniqueSeekToTimestamp } from '/@/renderer/store/player.store';
import { logger } from '/@/renderer/utils/logger';
import { PlayerType } from '/@/shared/types/types';

/**
 * Per-candidate probe timeout. The probe is an optimization for ordering
 * candidates — the WS handshake itself is the source of truth. We keep this
 * short so that unreachable hosts on a LAN scan don't delay connection.
 */
const PROBE_TIMEOUT_MS = 1_500;

export interface DlnaClientContextValue {
    client: DlnaClient | null;
    /**
     * Opaque string that changes whenever the client is swapped. Consumers
     * that hold event subscriptions should use this as a useEffect
     * dependency so they re-subscribe to the new client.
     */
    clientKey: string;
    /** Last error message (if any). Cleared on successful connection. */
    error: null | string;
    /** Human-readable status for the settings UI. */
    status: 'connected' | 'connecting' | 'disabled' | 'error' | 'idle';
}

export const DlnaClientContext = createContext<DlnaClientContextValue>({
    client: null,
    clientKey: 'none',
    error: null,
    status: 'idle',
});

export interface DlnaClientProviderProps {
    children: ReactNode;
}

export function DlnaClientProvider({ children }: DlnaClientProviderProps) {
    const cast = useCastSettings();
    const [state, setState] = useState<
        Pick<DlnaClientContextValue, 'client' | 'clientKey' | 'error' | 'status'>
    >({
        client: null,
        clientKey: 'none',
        error: null,
        status: 'idle',
    });

    // Track the currently-active WS client so we can tear it down cleanly
    // before building a new one.
    const activeClientRef = useRef<null | WsDlnaClient>(null);
    // Bumped each time we build a new client, used as `clientKey` so
    // consumers re-subscribe after a swap.
    const generationRef = useRef(0);

    // Memoize the candidate URL list so identical settings don't trigger
    // reconnect loops. We re-run the probe only when this string changes.
    const settingsFingerprint = useMemo(() => JSON.stringify(cast), [cast]);

    useEffect(() => {
        const generation = ++generationRef.current;

        // ----- Case 1: Electron with IPC backend ---------------------------
        if (isElectron() && cast.mode !== 'off') {
            const electronClient = createElectronDlnaClient({
                dlnaPlayer: window.api.dlnaPlayer,
                dlnaPlayerListener: window.api.dlnaPlayerListener,
                ipc: window.api.ipc,
            });
            activeClientRef.current = null;
            if (generation === generationRef.current) {
                setState({
                    client: electronClient,
                    clientKey: `electron-${generation}`,
                    error: null,
                    status: 'connected',
                });
            }
            return () => {
                // Electron IPC has per-channel lifecycle managed by
                // removeAllListeners in each unsubscribe fn. Nothing to do.
                castSessionActions.clear();
                if (generation === generationRef.current) {
                    setState({
                        client: null,
                        clientKey: 'none',
                        error: null,
                        status: 'idle',
                    });
                }
            };
        }

        // ----- Case 2: DLNA disabled ---------------------------------------
        if (cast.mode === 'off') {
            activeClientRef.current = null;
            castSessionActions.clear();
            if (generation === generationRef.current) {
                setState({
                    client: null,
                    clientKey: `off-${generation}`,
                    error: null,
                    status: 'disabled',
                });
            }
            return;
        }

        // ----- Case 3: web/Docker with WS backend ---------------------------
        const candidates = buildCandidateUrls(cast);
        if (candidates.length === 0) {
            if (generation === generationRef.current) {
                setState({
                    client: null,
                    clientKey: `no-servers-${generation}`,
                    error: 'No cast servers configured. Add one in Settings → Playback → Cast.',
                    status: 'error',
                });
            }
            return;
        }

        if (generation === generationRef.current) {
            setState({
                client: null,
                clientKey: `connecting-${generation}`,
                error: null,
                status: 'connecting',
            });
        }

        let cancelled = false;
        let wsClient: null | WsDlnaClient = null;

        // Mutable list — the probe phase reorders it once on startup, then
        // tryConnect walks it round-robin on each retry. We don't re-probe
        // on every reconnect because (a) the probe results are stable for
        // the order of seconds, and (b) re-probing would add latency to
        // every retry after a network blip.
        let orderedCandidates = candidates;

        const tryConnect = async (attempt: number) => {
            if (cancelled || generation !== generationRef.current) return;
            const url = orderedCandidates[attempt % orderedCandidates.length];

            // Tear down any prior client first.
            if (wsClient) {
                try {
                    wsClient.close();
                } catch {
                    // Ignore
                }
                wsClient = null;
            }

            const client = new WsDlnaClient(
                {
                    authToken: cast.authToken,
                    url,
                },
                {
                    onClose: (code, reason) => {
                        if (cancelled || generation !== generationRef.current) return;
                        logger.warn(`[DLNA] socket closed`, { code, reason, url });
                        activeClientRef.current = null;
                        // Drop the session RPC sender so store actions fall
                        // back to local mutation while we're reconnecting.
                        // `shouldForwardToServer()` returns false when
                        // `sessionRpcSender === null`, so all player actions
                        // (next/prev/seek/volume/...) immediately become
                        // local-only — preserving UI responsiveness during the
                        // backoff window. Re-registered in `onHello` when the
                        // new WS connects.
                        setSessionRpcSender(null);
                        // Keep the stale client reference in state so the cast
                        // button stays mounted during the reconnect backoff.
                        // The old `WsDlnaClient`'s `send()` no-ops when the
                        // socket isn't OPEN, so commands silently fail rather
                        // than crashing.  We only transition `status` to
                        // `'connecting'` — UI consumers (e.g. dlna-cast-button)
                        // can render a muted/disabled state instead of
                        // unmounting.
                        //
                        // When the new WS completes its hello, `onHello`
                        // below will replace the stale client with the fresh
                        // one and flip `status` back to `'connected'`.
                        setState((prev) => ({
                            ...prev,
                            error: `Casting server connection closed (${code}). Retrying...`,
                            status: 'connecting',
                        }));
                        // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
                        const delay = Math.min(30_000, 1_000 * Math.pow(2, attempt));
                        setTimeout(() => tryConnect(attempt + 1), delay);
                    },
                    onError: (err) => {
                        if (cancelled || generation !== generationRef.current) return;
                        logger.warn(`[DLNA] client error`, { err, url });
                    },
                    onHello: (hello) => {
                        if (cancelled || generation !== generationRef.current) return;
                        logger.info(`[DLNA] connected to casting server`, {
                            connected: hello.connected,
                            url,
                        });
                        activeClientRef.current = client;
                        // Register the WS client as the session RPC sender so
                        // that player store actions (next/prev/seek/volume/...)
                        // forward to the server when `isDlnaMode` is true.
                        // Cleared in `onClose` and on provider unmount.
                        setSessionRpcSender(client);
                        setState({
                            client,
                            clientKey: `ws-${generation}-${attempt}`,
                            error: null,
                            status: 'connected',
                        });

                        // If the server already has an active DLNA session,
                        // mirror it on this client.  We:
                        //   1. Set isDlnaMode + applyingRemoteUpdate FIRST, so
                        //      the engine's mount effects (which fire when
                        //      `setSettings` flips PlayerType to DLNA below)
                        //      observe `isDlnaMode === true` and skip the
                        //      legacy `sendCurrentTrackToDlna` / SOAP-firing
                        //      paths.  Setting these AFTER `setSettings`
                        //      leaves a window where the engine mounts, reads
                        //      `isDlnaMode === false`, and starts racing with
                        //      the snapshot apply.
                        //   2. Switch PlayerType to DLNA so the engine mounts
                        //      and registers its event listeners.
                        //   3. Apply the queue/player snapshot directly to the
                        //      player store.
                        //   4. Populate the cast-session store synchronously
                        //      so the cast button turns blue without relying
                        //      on a microtask-timed `emitLocal` event.
                        //   5. Defer clearing `applyingRemoteUpdate` via
                        //      `setTimeout(0)` — the wider window covers
                        //      React's commit-phase effects.  A microtask
                        //      runs before React's scheduler, so engine
                        //      effects could echo to the server before the
                        //      guard drops.
                        if (hello.connected) {
                            const storeState = useSettingsStore.getState();
                            const currentType = storeState.playback.type;

                            // (1) Flip the flags before any other store
                            // mutation so engine mount effects observe the
                            // correct state.
                            usePlayerStoreBase.setState((s) => {
                                s.isDlnaMode = true;
                                s.applyingRemoteUpdate = true;
                            });

                            // (2) Switch PlayerType.  Skip if already DLNA
                            // (a WS reconnect should leave the engine
                            // mounted — the snapshot re-sync below catches
                            // any drift).
                            if (currentType !== PlayerType.DLNA) {
                                playerHandoff.deviceAlreadyPlaying = false;
                                storeState.actions.setSettings({
                                    playback: {
                                        previousPlayerType: currentType ?? PlayerType.WEB,
                                        type: PlayerType.DLNA,
                                    },
                                });
                            }

                            // (3) Apply the snapshot.
                            if (hello.queueState) {
                                const { player, queue } = hello.queueState;
                                usePlayerStoreBase.setState((s) => {
                                    s.queue = {
                                        default: queue.default,
                                        shuffled: queue.shuffled,
                                        songs: queue.songs,
                                    };
                                    s.player.index = player.index;
                                    s.player.status = player.status;
                                    s.player.repeat = player.repeat;
                                    s.player.shuffle = player.shuffle;
                                    s.player.speed = player.speed;
                                    s.player.volume = player.volume;
                                    s.player.muted = player.muted;
                                    if (player.seekTo >= 0) {
                                        s.player.seekToTimestamp = uniqueSeekToTimestamp(
                                            player.seekTo,
                                        );
                                    }
                                });
                            } else if (typeof hello.volume === 'number' && hello.volume >= 0) {
                                usePlayerStoreBase.setState((s) => {
                                    s.player.volume = hello.volume!;
                                });
                            }

                            // (4) Populate the cast-session store
                            // synchronously.  The cast button, volume
                            // button, and any other consumer read from this
                            // store instead of subscribing to a
                            // microtask-timed `emitLocal('rendererDlnaGroupState')`
                            // event.  This eliminates the timing race where
                            // a secondary tab's cast-button `useEffect`
                            // hadn't re-registered its listener before the
                            // microtask fired.
                            //
                            // `hello.groupState` is populated by the server
                            // whenever the playback snapshot has members,
                            // regardless of `isServerAuthoritative()` (see
                            // `ws-transport.ts` `handleConnection`).  When
                            // it's missing or empty, we still mark the
                            // session as connected so the cast button
                            // turns blue; the next server-pushed
                            // `rendererDlnaGroupState` event will fill in
                            // the member list.
                            castSessionActions.setConnected({
                                groupMembers: hello.groupState ?? [],
                            });
                            // Also dispatch `hello.groupState` as a local
                            // event for components that still subscribe to
                            // the legacy `rendererDlnaGroupState` channel —
                            // notably `right-controls.tsx`'s
                            // `VolumeButton` (which keeps its own
                            // `groupMemberList`/`groupMembersRef` state
                            // populated from this event so the Sonos
                            // speaker properties popover works).  Deferred
                            // via `queueMicrotask` so the listener (which
                            // re-registers on `clientKey` change) has a
                            // chance to register before we emit.
                            if (hello.groupState) {
                                const groupState = hello.groupState;
                                queueMicrotask(() => {
                                    client.emitLocal('rendererDlnaGroupState', groupState);
                                });
                            }

                            // (5) Drop the guard after React has committed
                            // the snapshot and run mount effects.  Using
                            // `setTimeout(0)` instead of `queueMicrotask`
                            // widens the window from "before the next
                            // microtask" to "before the next task" — that
                            // extra ~one-task delay is enough to cover
                            // React's commit phase without being
                            // perceptible to users.
                            setTimeout(() => {
                                usePlayerStoreBase.setState({
                                    applyingRemoteUpdate: false,
                                });
                            }, 0);
                        } else {
                            // The casting server has no active DLNA session.
                            // This tab may have persisted `playbackType = DLNA`
                            // from an earlier session — `audio-players.tsx`
                            // skips its mount-reset on the WS path expecting
                            // us to drive the state, so we're responsible
                            // for flipping back to WEB here.  Use the
                            // persisted `previousPlayerType` when available,
                            // otherwise fall back to WEB.
                            const storeState = useSettingsStore.getState();
                            const fallback =
                                storeState.playback.previousPlayerType ?? PlayerType.WEB;
                            if (storeState.playback.type !== fallback) {
                                storeState.actions.setSettings({
                                    playback: { type: fallback },
                                });
                            }
                        }
                    },
                },
            );
            wsClient = client;
        };

        // Probe candidates once, then start the connect loop with the
        // reordered list. If the probe throws (unlikely — it catches
        // internally), we fall back to the original order.
        const start = async () => {
            try {
                const probed = await probeCandidates(candidates);
                if (cancelled || generation !== generationRef.current) return;
                if (probed.length > 0) {
                    orderedCandidates = probed;
                    logger.info(`[DLNA] probe reordered candidates`, {
                        after: probed,
                        before: candidates,
                    });
                }
            } catch (err) {
                logger.warn(`[DLNA] probe phase failed, using original order`, { err });
            }
            void tryConnect(0);
        };
        void start();

        return () => {
            cancelled = true;
            if (wsClient) {
                try {
                    wsClient.close();
                } catch {
                    // Ignore
                }
            }
            activeClientRef.current = null;
            castSessionActions.clear();
            if (generation === generationRef.current) {
                setState({
                    client: null,
                    clientKey: 'none',
                    error: null,
                    status: 'idle',
                });
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settingsFingerprint]);

    const value: DlnaClientContextValue = {
        client: state.client,
        clientKey: state.clientKey,
        error: state.error,
        status: state.status,
    };

    return <DlnaClientContext.Provider value={value}>{children}</DlnaClientContext.Provider>;
}

/**
 * Convenience hook returning just the client (or null).
 */
export function useDlnaClient(): DlnaClient | null {
    return useContext(DlnaClientContext).client;
}

/**
 * Convenience hook to consume the DlnaClient context.
 */
export function useDlnaClientContext(): DlnaClientContextValue {
    return useContext(DlnaClientContext);
}

/**
 * Build the list of candidate server URLs from settings.
 *
 * In manual mode (or when servers are configured), the URLs are used
 * verbatim — they're already fully-formed `ws://` or `wss://` strings.
 *
 * In auto mode with no configured servers, we derive candidates from
 * `window.location.hostname` on the default cast port (8180) plus
 * fallback ports (80, 443) that a reverse proxy might forward. The
 * probe sequence then ranks these by responsiveness.
 *
 * Note: `localhost` / `127.0.0.1` are intentionally NOT excluded. The
 * Docker deployment serves the web app at `http://localhost:9180` with
 * the casting server on `ws://localhost:8180` — both ports forwarded to
 * the same host — so probing localhost is the common case. When no
 * server is listening the probe fails fast (ECONNREFUSED, not a timeout)
 * and the button simply stays hidden until one appears.
 */
function buildCandidateUrls(cast: CastSettings): string[] {
    const configured = cast.servers.filter((s) => s.startsWith('ws://') || s.startsWith('wss://'));
    if (configured.length > 0) {
        return configured;
    }
    if (cast.mode === 'auto' && typeof window !== 'undefined' && window.location) {
        const { hostname } = window.location;
        if (hostname) {
            // Probe each candidate port in parallel; the first to respond
            // wins. Ports are ordered by likelihood: the default cast
            // server port first, then 443 (wss behind a TLS-terminating
            // proxy), then 80 (ws behind a plain proxy).
            return [`ws://${hostname}:8180`, `wss://${hostname}`, `ws://${hostname}`];
        }
    }
    return [];
}

/**
 * Probe all candidate URLs concurrently and return them sorted by
 * latency (fastest first). Candidates that fail the probe are appended
 * to the end in their original order — this matters because the HTTP
 * `/health` endpoint might be blocked by CORS or a firewall while the
 * WS upgrade still works. We don't want to exclude those entirely.
 */
async function probeCandidates(urls: string[]): Promise<string[]> {
    const results = await Promise.all(urls.map((url) => probeCandidateUrl(url)));
    const ok = results
        .filter((r): r is { latency: number; url: string } => r !== null)
        .sort((a, b) => a.latency - b.latency)
        .map((r) => r.url);
    const failed = urls.filter((url) => !ok.includes(url));
    return [...ok, ...failed];
}

/**
 * Probe a single candidate URL by fetching its `/health` endpoint.
 *
 * Returns the latency in ms if the server responds with `{ ok: true }`,
 * or `null` if the probe fails (network error, non-200, wrong body,
 * timeout). The `/health` endpoint sends `Access-Control-Allow-Origin: *`
 * so this works from any renderer origin.
 *
 * Uses an AbortController to enforce a tight 1.5s timeout — the probe
 * is purely an optimization for ordering, so we don't want slow
 * candidates to block the fast ones.
 */
async function probeCandidateUrl(wsUrl: string): Promise<null | { latency: number; url: string }> {
    const httpUrl = wsUrl.replace(/^ws/, 'http') + '/health';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const start = Date.now();
    try {
        const res = await fetch(httpUrl, {
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { ok?: boolean };
        if (!body?.ok) return null;
        return { latency: Date.now() - start, url: wsUrl };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
