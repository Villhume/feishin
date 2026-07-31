import type { CastQueueSnapshot, CastQueueSong } from '/@/shared/types/cast-types';

import { Loader } from '@mantine/core';
import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { DlnaDevice, GroupMember } from './dlna/types';

import { playerHandoff } from '../audio-player/engine/player-handoff';

import {
    castSessionActions,
    useCastSessionStore,
} from '/@/renderer/features/player/api/cast-session-store';
import { DlnaClientContext } from '/@/renderer/features/player/api/dlna-client-provider';
import { resolveQueueSongUrls } from '/@/renderer/features/player/api/dlna-session-sync';
import { DeviceList } from '/@/renderer/features/player/components/dlna/device-list';
import { GroupBuilder } from '/@/renderer/features/player/components/dlna/group-builder';
import {
    usePlaybackSettings,
    usePlayerActions,
    usePlayerVolume,
    useSettingsStore,
    useSettingsStoreActions,
} from '/@/renderer/store';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { AppIcon } from '/@/shared/components/icon/icon';
import { Popover } from '/@/shared/components/popover/popover';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { PlayerType } from '/@/shared/types/types';

/**
 * Popover-internal view state. Connection-level state (isConnected,
 * deviceName, groupMembers, coordinator) lives in `useCastSessionStore` so
 * it's shared across tabs and survives popover close/reopen. `screen` only
 * governs what the popover shows when open.
 *
 * `view-connected` / `view-group` are the "casting to..." screens, derived
 * from the store when the popover opens. `idle` shows device discovery.
 * `connecting` / `group-build` / `expand-group` are transient flows.
 */
type Screen =
    | 'connecting'
    | 'expand-group'
    | 'group-build'
    | 'idle'
    | 'view-connected'
    | 'view-group';

function isSonosDevice(device: DlnaDevice): boolean {
    return device.id.toUpperCase().includes('RINCON');
}

export const DlnaCastButton = () => {
    const { setSettings } = useSettingsStoreActions();
    const { t } = useTranslation();
    const { mediaPause, setVolume } = usePlayerActions();
    const volume = usePlayerVolume();
    const settings = usePlaybackSettings();
    // Source of truth for the DLNA backend. See dlna-client-provider.tsx.
    // `null` means DLNA is unavailable (Electron w/o IPC, web w/o server).
    const { client: dlnaPlayer, clientKey, status } = useContext(DlnaClientContext);

    // Connection-level state lives in the cast-session store so every tab
    // shares the same source of truth. The provider populates it from the
    // WS `hello` handshake; user actions (connect/group/disconnect) write
    // to it here.
    const isConnected = useCastSessionStore((s) => s.isConnected);
    const connectedDeviceName = useCastSessionStore((s) => s.connectedDeviceName);
    const groupMemberList = useCastSessionStore((s) => s.groupMembers);
    const coordinator = useCastSessionStore((s) => s.coordinator);

    // Stable ref to the current DLNA client. The memoized callbacks below
    // (handleDiscover, handleSelect, etc.) read from this ref instead of the
    // `dlnaPlayer` variable so they always see the latest client without
    // needing it in their dependency arrays. Without this, the callbacks
    // capture `null` on first render (before the WS handshake completes) and
    // silently no-op every subsequent call — the stale-closure bug that
    // caused "No DLNA devices found" in the web/Docker path.
    const dlnaPlayerRef = useRef(dlnaPlayer);
    dlnaPlayerRef.current = dlnaPlayer;

    // Popover-internal view. Derived from the store when the popover opens
    // (see the onClick handler in the ActionIcon below).
    const [screen, setScreen] = useState<Screen>('idle');
    const [showPopover, setShowPopover] = useState(false);
    const [devices, setDevices] = useState<DlnaDevice[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isShiftDown, setIsShiftDown] = useState(false);

    const previousPlayerTypeRef = useRef<PlayerType>(
        settings.type === PlayerType.DLNA ? PlayerType.WEB : settings.type,
    );

    const hasSonosDevices = devices.some(isSonosDevice);
    useEffect(() => {
        if (!showPopover) return;
        const onKey = (e: KeyboardEvent) => setIsShiftDown(e.shiftKey);
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('keyup', onKey);
            setIsShiftDown(false);
        };
    }, [showPopover]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = (payload: { message: string; type: 'error' | 'info' | 'warning' }) => {
            if (payload.type === 'error') {
                toast.error({ message: payload.message });
            } else if (payload.type === 'warning') {
                toast.warn?.({ message: payload.message });
            } else {
                toast.info?.({ message: payload.message });
            }
        };
        return dlnaPlayer.on('rendererDlnaToast', handler);
    }, [dlnaPlayer, clientKey]);

    useEffect(() => {
        if (!dlnaPlayer) return;
        const handleGroupState = (state: GroupMember[]) => {
            if (state.length === 0) {
                // Server broadcasted an empty group state — the DLNA
                // session has ended (originating tab disconnected, or
                // server lost the device).  Revert this tab to local
                // mode so the engine unmounts, store mutations stop
                // forwarding to the server, and the cast button turns
                // grey.  Without this, other tabs stay stuck in a zombie
                // DLNA state after one tab disconnects.
                if (usePlayerStoreBase.getState().isDlnaMode) {
                    usePlayerStoreBase.setState({
                        applyingRemoteUpdate: false,
                        isDlnaMode: false,
                    });
                    const storeState = useSettingsStore.getState();
                    const fallback = storeState.playback.previousPlayerType ?? PlayerType.WEB;
                    if (storeState.playback.type !== fallback) {
                        storeState.actions.setSettings({
                            playback: {
                                previousLocalVolume: undefined,
                                previousPlayerType: undefined,
                                type: fallback,
                            },
                        });
                    }
                }
                castSessionActions.clear();
                setScreen('idle');
                return;
            }
            // Server-pushed group updates replace the store's member list.
            // The store derives `connectedDeviceName` and `coordinator`
            // from the members; pass the translated group label so it wins
            // over the default "N speakers" placeholder.
            const label =
                state.length > 1
                    ? t('dlna.castingToGroup', { count: state.length })
                    : state[0]?.device.name;
            castSessionActions.setGroupMembers(state, label);
        };
        const unsubscribe = dlnaPlayer.on('rendererDlnaGroupState', handleGroupState);
        // Paint the group state immediately if the client already has a
        // cached snapshot (e.g. from the `hello` handshake on a secondary
        // tab). The cast-session store is the source of truth for the cast
        // button's blue state, but the member list (for the popover's group
        // view) still benefits from this eager paint.
        const cached = dlnaPlayer.getCachedGroupState?.();
        if (cached && cached.length > 0) {
            handleGroupState(cached);
        }
        return unsubscribe;
    }, [t, dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handleDiscoveryUpdate = (updated: DlnaDevice[]) => {
            setDevices((current) => {
                if (screen !== 'idle') return current;
                const hasNewGroups = updated.some((d) => d.groupMembers);
                if (!hasNewGroups) return current;
                return updated;
            });
        };
        return dlnaPlayer.on('rendererDlnaDiscoveryUpdate', handleDiscoveryUpdate);
    }, [screen, dlnaPlayer, clientKey]);

    const handleDiscover = useCallback(async () => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        setDevices([]);
        setIsLoading(true);
        try {
            setDevices(await client.discover());
        } catch {
            setDevices([]);
        } finally {
            setIsLoading(false);
        }
    }, []);

    const refreshGroupState = useCallback(async () => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        try {
            const state = await client.getGroupState();
            const label =
                state.length > 1
                    ? t('dlna.castingToGroup', { count: state.length })
                    : state[0]?.device.name;
            castSessionActions.setGroupMembers(state, label);
        } catch {
            // Catch
        }
    }, [t]);

    /**
     * Server-authoritative session: hand the current renderer queue + player
     * state to the server. The server now owns the queue; local mutations
     * forward via RPC. Skipped when:
     *   - The device was already playing something (the server-side session
     *     likely already has a queue — `hello.queueState` on reconnect
     *     will populate us instead).
     *   - The client isn't WS-backed (Electron IPC path keeps using the
     *     legacy `playUrl` mechanism).
     *   - The queue is empty (nothing to hand over).
     *
     * Resolves stream URLs / album art / MIME types for every song before
     * sending — the server has no Navidrome API client and can't resolve
     * these itself. Without resolution, the server's
     * `sendCurrentTrackFromSession()` finds `song.resolvedStreamUrl`
     * undefined and bails without issuing `playUrl` to the device.
     * Resolution runs in parallel via `Promise.all`; for a typical queue
     * of 50-200 songs this completes in 1-3 seconds (parallel HEAD
     * requests), during which the popover shows the "connecting" spinner.
     *
     * Sends the snapshot first, THEN flips `isDlnaMode` so state mutations
     * during the await don't race back to the server.
     */
    const handoffQueueToServer = useCallback(
        async (
            client: { isWsClient: boolean } & {
                setQueue: (
                    queue: CastQueueSnapshot,
                    playerState?: Partial<import('/@/shared/types/cast-types').CastPlayerState>,
                ) => Promise<{ ok: boolean }>;
            },
            volume: number,
            currentTimestamp: number,
        ) => {
            if (!client.isWsClient || playerHandoff.deviceAlreadyPlaying) return;
            const storeState = usePlayerStoreBase.getState();
            const queueItems = storeState.getQueueOrder().items;
            // Always call `client.setQueue(...)`, even when the queue is
            // empty.  The previous early-return here set `isDlnaMode` on
            // the renderer but never told the server to flip
            // `serverAuthoritative = true`, so all subsequent
            // `sessionSet*` RPCs (shuffle, repeat, speed, ...) returned
            // `{ ok: false }` and were silently dropped — breaking
            // shuffle/repeat sync between tabs.
            //
            // The server's `setQueue` handler (controller.ts) handles
            // empty snapshots: it stores them, flips
            // `serverAuthoritative = true`, broadcasts
            // `rendererQueueState`, and if there's no current song,
            // `sendCurrentTrackFromSession` returns early without firing
            // a device command.  Safe.
            let snapshot: CastQueueSnapshot;
            if (queueItems.length === 0) {
                snapshot = { default: [], shuffled: [], songs: {} };
            } else {
                // Resolve stream URLs / album art / MIME types for every
                // song in parallel.  The server uses these verbatim when
                // it calls `playUrl` on the device — without them,
                // playback never starts.
                const transcode = useSettingsStore.getState().playback.transcode;
                const songs = storeState.queue.songs;
                const resolved = await Promise.all(
                    Object.values(songs).map((song) => resolveQueueSongUrls(song, transcode)),
                );
                const resolvedSongs: Record<string, CastQueueSong> = {};
                for (const song of resolved) {
                    resolvedSongs[song._uniqueId] = song;
                }
                snapshot = {
                    default: storeState.queue.default,
                    shuffled: storeState.queue.shuffled,
                    songs: resolvedSongs,
                };
            }
            const playerPatch = {
                index: storeState.player.index,
                muted: storeState.player.muted,
                repeat: storeState.player.repeat,
                seekTo: currentTimestamp > 0 ? currentTimestamp : -1,
                shuffle: storeState.player.shuffle,
                speed: storeState.player.speed,
                status: storeState.player.status,
                volume,
            };
            await client.setQueue(snapshot, playerPatch);
            usePlayerStoreBase.setState({ isDlnaMode: true });
        },
        [],
    );

    const handleSelect = useCallback(
        async (device: DlnaDevice) => {
            const client = dlnaPlayerRef.current;
            if (!client) return;
            const currentTimestamp = useTimestampStoreBase.getState().timestamp;
            if (currentTimestamp > 0) {
                playerHandoff.pendingDlnaSeek = currentTimestamp;
            }
            if (settings.type !== PlayerType.DLNA) {
                previousPlayerTypeRef.current = settings.type;
            }
            setScreen('connecting');
            const result = await client.connect(device);
            if (result.success) {
                setVolume(result.volume);
                if (result.currentUri && result.currentTransportState !== 'STOPPED') {
                    playerHandoff.deviceTransportState = result.currentTransportState;
                    playerHandoff.deviceCurrentUri = result.currentUri;
                    playerHandoff.deviceNextUri = result.nextUri || '';
                    playerHandoff.devicePosition = result.currentPosition || 0;
                    if (result.currentTransportState === 'PAUSED_PLAYBACK') {
                        playerHandoff.deviceAlreadyPlaying = true;
                        playerHandoff.deviceWasPaused = true;
                    } else {
                        playerHandoff.pendingDlnaSeek = -1;
                        playerHandoff.deviceAlreadyPlaying = true;
                        playerHandoff.deviceWasPaused = false;
                    }
                } else if (!result.currentUri) {
                    await handoffQueueToServer(client, result.volume, currentTimestamp);
                }
                setSettings({
                    playback: {
                        ...settings,
                        previousLocalVolume: volume,
                        previousPlayerType:
                            settings.type !== PlayerType.DLNA ? settings.type : PlayerType.WEB,
                        type: PlayerType.DLNA,
                    },
                });
                if (device.groupMembers && device.groupMembers.length > 1) {
                    const initialMembers: GroupMember[] = device.groupMembers.map((m) => ({
                        device: m as DlnaDevice,
                        isCoordinator: m.id === device.id,
                        volume: m.id === device.id ? result.volume : 50,
                    }));
                    castSessionActions.setConnected({
                        connectedDeviceName: t('dlna.castingToGroup', {
                            count: initialMembers.length,
                        }),
                        groupMembers: initialMembers,
                    });
                    setScreen('view-group');
                } else {
                    castSessionActions.setConnected({
                        groupMembers: [{ device, isCoordinator: true, volume: result.volume }],
                    });
                    setScreen('view-connected');
                }
            } else {
                playerHandoff.pendingDlnaSeek = -1;
                setScreen('idle');
            }
        },
        [handoffQueueToServer, setSettings, setVolume, settings, volume, t],
    );

    const handleGroupConfirm = useCallback(
        async (selected: DlnaDevice[], coordinatorDevice: DlnaDevice) => {
            const client = dlnaPlayerRef.current;
            if (!client || selected.length < 2) return;
            const currentTimestamp = useTimestampStoreBase.getState().timestamp;
            if (currentTimestamp > 0) {
                playerHandoff.pendingDlnaSeek = currentTimestamp;
            }
            if (settings.type !== PlayerType.DLNA) {
                previousPlayerTypeRef.current = settings.type;
            }
            setScreen('connecting');
            const result = await client.connect(coordinatorDevice);
            if (!result.success) {
                playerHandoff.pendingDlnaSeek = -1;
                setScreen('group-build');
                return;
            }
            if (result.currentUri && result.currentTransportState !== 'STOPPED') {
                if (result.currentTransportState === 'PAUSED_PLAYBACK') {
                    playerHandoff.deviceAlreadyPlaying = true;
                    playerHandoff.deviceWasPaused = true;
                } else {
                    playerHandoff.pendingDlnaSeek = -1;
                    playerHandoff.deviceAlreadyPlaying = true;
                    playerHandoff.deviceWasPaused = false;
                }
            } else if (!result.currentUri) {
                await handoffQueueToServer(client, result.volume, currentTimestamp);
            }
            setVolume(result.volume);
            setSettings({
                playback: {
                    ...settings,
                    previousLocalVolume: volume,
                    previousPlayerType:
                        settings.type !== PlayerType.DLNA ? settings.type : PlayerType.WEB,
                    type: PlayerType.DLNA,
                },
            });
            const initialMembers: GroupMember[] = [
                { device: coordinatorDevice, isCoordinator: true, volume: result.volume },
            ];
            for (const member of selected.filter((d) => d.id !== coordinatorDevice.id)) {
                const r = await client.addGroupMember(member);
                if (r.success) {
                    initialMembers.push({ device: member, isCoordinator: false, volume: 50 });
                } else {
                    toast.error({
                        message: t('dlna.group.failedToAddMessage', { name: member.name }),
                        title: t('dlna.group.failedToAddTitle'),
                    });
                }
            }
            castSessionActions.setConnected({
                connectedDeviceName: t('dlna.castingToGroup', {
                    count: initialMembers.length,
                }),
                groupMembers: initialMembers,
            });
            setScreen('view-group');
        },
        [handoffQueueToServer, setSettings, setVolume, settings, volume, t],
    );

    const handleExpandGroupConfirm = useCallback(
        async (selected: DlnaDevice[], coordinator: DlnaDevice) => {
            const client = dlnaPlayerRef.current;
            if (!client) return;
            const toAdd = selected.filter((d) => d.id !== coordinator.id);
            const newMembers = [...groupMemberList];
            for (const member of toAdd) {
                const r = await client.addGroupMember(member);
                if (r.success) {
                    newMembers.push({ device: member, isCoordinator: false, volume: 50 });
                } else {
                    toast.error({
                        message: t('dlna.group.failedToAddMessage', { name: member.name }),
                        title: t('dlna.group.failedToAddTitle'),
                    });
                }
            }
            castSessionActions.setGroupMembers(
                newMembers,
                t('dlna.castingToGroup', { count: newMembers.length }),
            );
            setScreen('view-group');
        },
        [groupMemberList, t],
    );

    const handleRemoveMember = useCallback(
        async (deviceId: string) => {
            const client = dlnaPlayerRef.current;
            if (!client) return;
            await client.removeGroupMember(deviceId);
            const next = groupMemberList.filter((m) => m.device.id !== deviceId);
            if (next.length === 1) {
                castSessionActions.setConnected({
                    groupMembers: next,
                });
                setScreen('view-connected');
            } else {
                castSessionActions.setGroupMembers(
                    next,
                    t('dlna.castingToGroup', { count: next.length }),
                );
            }
        },
        [groupMemberList, t],
    );

    const handleDisconnect = useCallback(async () => {
        const client = dlnaPlayerRef.current;
        if (!client) return;
        const position = await client.getPosition();
        if (position > 0) playerHandoff.pendingLocalSeek = position;

        if (isShiftDown) {
            await client.disconnectPassive();
            mediaPause?.();
        } else {
            await client.disconnect();
        }

        // Server-authoritative session: revert to local-owned queue. Any
        // subsequent store action mutates locally (or whichever engine
        // takes over after PlayerType switches back). Also clear
        // `applyingRemoteUpdate` in case a remote update was in flight.
        usePlayerStoreBase.setState({
            applyingRemoteUpdate: false,
            isDlnaMode: false,
        });

        castSessionActions.clear();
        setScreen('idle');
        setShowPopover(false);
        // Read `previousPlayerType` from the persisted store, not the local
        // ref. The ref is only updated in `handleSelect`/`handleGroupConfirm`
        // (originating-tab connect), but a secondary tab that connected via
        // WS `onHello` never updates the ref — the provider wrote
        // `previousPlayerType` to the store instead. Reading from the store
        // ensures both paths get the correct pre-DLNA player type.
        const storeState = useSettingsStore.getState();
        const previousType = storeState.playback.previousPlayerType;
        const nextType =
            previousType === undefined || previousType === PlayerType.DLNA
                ? PlayerType.WEB
                : previousType;
        setSettings({
            playback: {
                ...settings,
                previousLocalVolume: undefined,
                previousPlayerType: undefined,
                type: nextType,
            },
        });
        if (settings.previousLocalVolume !== undefined) setVolume(settings.previousLocalVolume);
        setDevices([]);
        void handleDiscover();
    }, [setSettings, setVolume, settings, handleDiscover, mediaPause, isShiftDown]);

    useEffect(() => {
        if (settings.previousLocalVolume !== undefined) {
            const typeToRestore =
                settings.previousPlayerType === PlayerType.DLNA
                    ? PlayerType.WEB
                    : (settings.previousPlayerType ?? previousPlayerTypeRef.current);
            setSettings({
                playback: {
                    ...settings,
                    previousLocalVolume: undefined,
                    previousPlayerType: undefined,
                    type: typeToRestore,
                },
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Render the cast button whenever a DLNA backend is available. This
    // replaces the old `isElectron()` gate so the button also shows up in
    // the web/Docker build when a casting server is configured.
    //
    // During a WS reconnect, the provider keeps the stale client in state
    // (so commands no-op rather than crash) and transitions `status` to
    // `'connecting'`.  We keep the button mounted during that window —
    // otherwise it would flicker out for the 1-30s backoff duration every
    // time the network blips.  Only when there is truly no backend (i.e.
    // `idle`/`disabled`/`error` with no client) do we return null.
    if (!dlnaPlayer && status !== 'connecting') return null;

    // Look up the full DlnaDevice for the coordinator (the store only holds
    // id + name). Falls back to the first group member if the coordinator
    // entry isn't found.
    const coordinatorDevice =
        groupMemberList.find((m) => m.device.id === coordinator?.id)?.device ??
        (groupMemberList[0]?.device as DlnaDevice | undefined);

    const expandGroupDevices = devices.filter(
        (d) =>
            d.id === coordinator?.id ||
            (isSonosDevice(d) &&
                !d.groupMembers &&
                !groupMemberList.some((m) => m.device.id === d.id)),
    );

    return (
        <Popover onChange={setShowPopover} opened={showPopover} position="top">
            <Popover.Target>
                <ActionIcon
                    icon="cast"
                    iconProps={{ color: isConnected ? 'primary' : undefined, size: 'lg' }}
                    onClick={(e) => {
                        e.stopPropagation();
                        const opening = !showPopover;
                        setShowPopover(opening);
                        if (opening) {
                            if (!isConnected) {
                                setScreen('idle');
                                void handleDiscover();
                            } else {
                                // Derive the popover's view from the store
                                // state so opening the popover in a
                                // secondary tab shows "now casting" rather
                                // than the discovery list.
                                setScreen(
                                    groupMemberList.length > 1 ? 'view-group' : 'view-connected',
                                );
                                void refreshGroupState();
                            }
                        }
                    }}
                    size="sm"
                    tooltip={{
                        label: isConnected
                            ? groupMemberList.length > 1
                                ? t('dlna.castingToGroup', { count: groupMemberList.length })
                                : t('dlna.castingToDevice', { name: connectedDeviceName })
                            : t('dlna.castToDevice'),
                        openDelay: 0,
                    }}
                    variant="subtle"
                />
            </Popover.Target>

            <Popover.Dropdown style={{ minWidth: 340 }}>
                <div onClick={(e) => e.stopPropagation()}>
                    {screen === 'connecting' && (
                        <Group p="sm">
                            <Loader color="gray" size={12} type="bars" />
                            <Text c="dimmed">{t('dlna.connecting')}</Text>
                        </Group>
                    )}
                    {screen === 'group-build' && (
                        <GroupBuilder
                            devices={devices}
                            isLoading={isLoading}
                            onCancel={() => setScreen('idle')}
                            onConfirm={handleGroupConfirm}
                            onRefresh={handleDiscover}
                        />
                    )}
                    {screen === 'expand-group' && coordinatorDevice && (
                        <GroupBuilder
                            devices={expandGroupDevices}
                            isLoading={isLoading}
                            lockedCoordinator={coordinatorDevice}
                            onCancel={() =>
                                setScreen(
                                    groupMemberList.length > 1 ? 'view-group' : 'view-connected',
                                )
                            }
                            onConfirm={handleExpandGroupConfirm}
                            onRefresh={handleDiscover}
                        />
                    )}
                    {screen === 'idle' && (
                        <>
                            <Text fw="600" pb="md" size="sm" ta="center">
                                {t('dlna.devices')}
                            </Text>
                            {devices
                                .filter((d) => d.groupMembers && d.groupMembers.length > 1)
                                .map((groupDevice) => (
                                    <div
                                        key={groupDevice.id}
                                        onClick={() => void handleSelect(groupDevice)}
                                        style={{
                                            borderRadius: 6,
                                            cursor: 'pointer',
                                            marginBottom: 4,
                                            padding: '8px 10px',
                                        }}
                                    >
                                        <Text fw={600} size="sm">
                                            {groupDevice.name}
                                        </Text>
                                        {groupDevice.groupMembers!.map((m) => (
                                            <Text
                                                c="dimmed"
                                                fw={m.id === groupDevice.id ? 700 : 400}
                                                key={m.id}
                                                size="xs"
                                                style={{ paddingLeft: 8 }}
                                            >
                                                {m.name}
                                            </Text>
                                        ))}
                                    </div>
                                ))}
                            <DeviceList
                                devices={devices.filter(
                                    (d) => !d.groupMembers || d.groupMembers.length <= 1,
                                )}
                                isLoading={isLoading}
                                onSelect={handleSelect}
                                showEmptyState={devices.length === 0}
                            />
                            {!isLoading && (
                                <Group gap="xs" mt="sm">
                                    <Button
                                        flex={
                                            hasSonosDevices && devices.length >= 2 ? 1 : undefined
                                        }
                                        fullWidth={!hasSonosDevices || devices.length < 2}
                                        leftSection={<AppIcon.refresh size={12} />}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            void handleDiscover();
                                        }}
                                        size="xs"
                                        variant="outline"
                                    >
                                        {t('dlna.group.refresh')}
                                    </Button>
                                    {hasSonosDevices && devices.length >= 2 && (
                                        <Button
                                            flex={1}
                                            leftSection={<AppIcon.group size={12} />}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setScreen('group-build');
                                            }}
                                            size="xs"
                                            variant="outline"
                                        >
                                            {t('dlna.createGroup')}
                                        </Button>
                                    )}
                                </Group>
                            )}
                        </>
                    )}
                    {screen === 'view-connected' && (
                        <>
                            <Text fw="600" pb="md" size="sm" ta="center">
                                {t('dlna.nowCasting')}
                            </Text>

                            <Text c="dimmed" size="sm">
                                {connectedDeviceName}
                            </Text>
                            <Group gap="xs" mt="sm">
                                {coordinatorDevice && isSonosDevice(coordinatorDevice) && (
                                    <Button
                                        flex={1}
                                        leftSection={<AppIcon.group size={12} />}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setScreen('expand-group');
                                            void handleDiscover();
                                        }}
                                        size="xs"
                                        variant="outline"
                                    >
                                        {t('dlna.group.addToGroup')}
                                    </Button>
                                )}
                                <Button
                                    color={isShiftDown ? 'white' : 'red'}
                                    flex={1}
                                    onClick={handleDisconnect}
                                    size="xs"
                                    style={{
                                        color: isShiftDown
                                            ? undefined
                                            : 'var(--mantine-color-red-4, #ff6b6b)',
                                    }}
                                    variant="outline"
                                >
                                    {t('dlna.disconnect')}
                                </Button>
                            </Group>
                            <Text
                                c="dimmed"
                                mt={6}
                                size="xs"
                                style={{
                                    opacity: isShiftDown ? 0 : 1,
                                    textAlign: 'center',
                                    transition: 'opacity 150ms',
                                }}
                            >
                                {t('dlna.shiftDisconnectHint')}
                            </Text>
                        </>
                    )}
                    {screen === 'view-group' && (
                        <>
                            <Text fw="600" pb="md" size="sm" ta="center">
                                {t('dlna.group.title', { count: groupMemberList.length })}
                            </Text>

                            {groupMemberList.map((member) => (
                                <Group
                                    justify="space-between"
                                    key={member.device.id}
                                    px="sm"
                                    py={4}
                                >
                                    <Group>
                                        <Text
                                            c={member.isCoordinator ? 'primary' : undefined}
                                            size="sm"
                                        >
                                            {member.device.name}
                                        </Text>
                                        {member.isCoordinator && <AppIcon.star size={12} />}
                                    </Group>

                                    {!member.isCoordinator && !member.device.isPair && (
                                        <Button
                                            color="red"
                                            onClick={() => handleRemoveMember(member.device.id)}
                                            size="compact-xs"
                                            style={{
                                                color: 'var(--mantine-color-red-4, #ff6b6b)',
                                            }}
                                            variant="subtle"
                                        >
                                            {t('dlna.group.remove')}
                                        </Button>
                                    )}
                                </Group>
                            ))}

                            <Group gap="xs" mt="sm">
                                <Button
                                    flex={1}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setScreen('expand-group');
                                        void handleDiscover();
                                    }}
                                    size="xs"
                                    variant="outline"
                                >
                                    {t('dlna.group.addSpeaker')}
                                </Button>
                                <Button
                                    color={isShiftDown ? 'white' : 'red'}
                                    flex={1}
                                    onClick={handleDisconnect}
                                    size="xs"
                                    style={{
                                        color: isShiftDown
                                            ? undefined
                                            : 'var(--mantine-color-red-4, #ff6b6b)',
                                    }}
                                    variant="outline"
                                >
                                    {t('dlna.disconnect')}
                                </Button>
                            </Group>
                            <Text
                                c="dimmed"
                                mt={6}
                                size="xs"
                                style={{
                                    opacity: isShiftDown ? 0 : 1,
                                    textAlign: 'center',
                                    transition: 'opacity 150ms',
                                }}
                            >
                                {t('dlna.shiftDisconnectHint')}
                            </Text>
                        </>
                    )}
                </div>
            </Popover.Dropdown>
        </Popover>
    );
};
