import { useMutation, useQueryClient } from '@tanstack/react-query';
import { t } from 'i18next';
import { useCallback, useEffect, useRef } from 'react';

import { api } from '/@/renderer/api';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import {
    setTimestamp,
    useCurrentServerId,
    usePlayerActions,
    usePlayerHydrated,
    usePlayerSong,
    usePlayerStatus,
    usePlayerStore,
    useTimestampStoreBase,
} from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerStatus } from '/@/shared/types/types';

let startupRestoreSessionHandled = false;

export const useQueueRestoreTimestamp = () => {
    const { mediaSeekToTimestamp } = usePlayerActions();

    usePlayerEvents(
        {
            onQueueRestored: (properties) => {
                const { position } = properties;

                // Skip in DLNA mode — the server is authoritative for
                // position and the queue snapshot already applied it.
                // Forwarding a seek here would send an RPC to the device
                // and interrupt playback.
                if (usePlayerStore.getState().isDlnaMode) return;

                setTimeout(() => {
                    setTimestamp(position);
                    mediaSeekToTimestamp(position);
                }, 100);
            },
        },
        [],
    );
};

export const QueueRestoreTimestampHook = () => {
    useQueueRestoreTimestamp();
    return null;
};

export const useInitialTimestampRestore = () => {
    const { mediaSeekToTimestamp } = usePlayerActions();
    const playerHydrated = usePlayerHydrated();
    const currentSong = usePlayerSong();
    const playerStatus = usePlayerStatus();
    const timestamp = useTimestampStoreBase((state) => state.timestamp);

    const startupRestoreInitializedRef = useRef(false);
    const startupSeekArmedRef = useRef<null | number>(null);
    const startupSeekTargetUniqueIdRef = useRef<null | string>(null);
    const startupSeekAppliedRef = useRef(false);

    const cancelStartupSeek = useCallback(() => {
        if (startupSeekAppliedRef.current) {
            return;
        }

        startupSeekAppliedRef.current = true;
        startupSeekArmedRef.current = null;
        startupSeekTargetUniqueIdRef.current = null;
    }, []);

    const applyStartupSeek = useCallback(() => {
        // Must check at call time — `onPlayerStatus` fires this AFTER
        // `onHello` sets `isDlnaMode = true`, so the mount-effect guard
        // (checked before `onHello`) is too early and the seek would
        // still be armed when this fires.
        if (usePlayerStore.getState().isDlnaMode) {
            return;
        }

        const seekTimestamp = startupSeekArmedRef.current;

        if (startupSeekAppliedRef.current) {
            return;
        }

        if (!seekTimestamp || seekTimestamp <= 0) {
            return;
        }

        const targetUniqueId = startupSeekTargetUniqueIdRef.current;
        const currentUniqueId = usePlayerStore.getState().getCurrentSong()?._uniqueId;

        if (targetUniqueId && currentUniqueId !== targetUniqueId) {
            cancelStartupSeek();
            return;
        }

        startupSeekAppliedRef.current = true;
        startupSeekArmedRef.current = null;
        startupSeekTargetUniqueIdRef.current = null;

        setTimeout(() => {
            mediaSeekToTimestamp(seekTimestamp);
        }, 100);
    }, [cancelStartupSeek, mediaSeekToTimestamp]);

    useEffect(() => {
        const targetUniqueId = startupSeekTargetUniqueIdRef.current;
        if (
            !targetUniqueId ||
            startupSeekAppliedRef.current ||
            !currentSong ||
            currentSong._uniqueId === targetUniqueId
        ) {
            return;
        }

        cancelStartupSeek();
    }, [cancelStartupSeek, currentSong]);

    useEffect(() => {
        if (startupRestoreInitializedRef.current || startupRestoreSessionHandled) {
            return;
        }

        if (!playerHydrated || !currentSong) {
            return;
        }

        startupRestoreInitializedRef.current = true;
        startupRestoreSessionHandled = true;

        // Skip startup seek in DLNA mode — the server snapshot (applied
        // via the `hello` handshake or `rendererQueueState` event) already
        // has the correct position.  Forwarding a seek RPC here would
        // interrupt playback on the device.  This was the root cause of
        // audio stuttering when a new tab opens mid-session: this hook
        // fired `mediaSeekToTimestamp` via `setTimeout(100)` after the
        // `applyingRemoteUpdate` guard dropped, forwarding a seek RPC.
        if (usePlayerStore.getState().isDlnaMode) {
            return;
        }

        if (timestamp > 0) {
            startupSeekArmedRef.current = timestamp;
            startupSeekTargetUniqueIdRef.current = currentSong._uniqueId;
        }

        if (playerStatus === PlayerStatus.PLAYING) {
            applyStartupSeek();
        }
    }, [applyStartupSeek, currentSong, playerHydrated, playerStatus, timestamp]);

    usePlayerEvents(
        {
            onPlayerStatus: (properties) => {
                if (properties.status === PlayerStatus.PLAYING) {
                    applyStartupSeek();
                }
            },
        },
        [applyStartupSeek],
    );
};

export const InitialTimestampRestoreHook = () => {
    useInitialTimestampRestore();
    return null;
};

export const useSaveQueue = () => {
    const serverId = useCurrentServerId();

    const mutation = useMutation({
        mutationFn: async () => {
            if (!serverId) {
                throw new Error(t('error.serverRequired'));
            }

            const state = usePlayerStore.getState();
            const queue = state.getQueue();

            if (queue.items.some((item) => item._serverId !== serverId)) {
                toast.error({
                    message: t('error.multipleServerSaveQueueError'),
                    title: t('error.genericError'),
                });

                throw new Error(`${t('error.multipleServerSaveQueueError')}`);
            }

            return api.controller.savePlayQueue({
                apiClientProps: { serverId },
                query: {
                    currentIndex: queue.items.length > 0 ? state.player.index : undefined,
                    positionMs: useTimestampStoreBase.getState().timestamp * 1000,
                    songs: queue.items.map((item) => item.id),
                },
            });
        },
        onError: (error) => {
            toast.error({
                message: (error as Error).message,
                title: t('error.saveQueueFailed'),
            });
        },
    });

    return mutation;
};

export const useRestoreQueue = () => {
    const serverId = useCurrentServerId();
    const player = usePlayer();
    const queryClient = useQueryClient();

    const handleRestoreQueue = useCallback(async () => {
        if (!serverId) return;

        try {
            const queue = await queryClient.fetchQuery(
                songsQueries.getQueue({ query: {}, serverId }),
            );

            if (queue) {
                player.setQueue(
                    queue.entry,
                    queue.currentIndex,
                    queue.positionMs !== undefined ? queue.positionMs / 1000 : undefined,
                );
            }
        } catch (error) {
            toast.error({
                message: (error as Error).message,
                title: t('error.genericError'),
            });
        }
    }, [player, queryClient, serverId]);

    return handleRestoreQueue;
};
