import { useContext, useEffect, useRef } from 'react';

import { DlnaClientContext } from '/@/renderer/features/player/api/dlna-client-provider';
import { useRadioPlayer, useRadioStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { usePlayerActions, usePlayerMuted, usePlayerVolume } from '/@/renderer/store';

export function RadioDlnaPlayer() {
    const { client: dlnaPlayer, clientKey } = useContext(DlnaClientContext);
    // Stable ref so the playUrl/volume/mute effects below always see the
    // latest client. Without this they would capture `null` from the first
    // render (before the WS handshake completes) and silently no-op — the
    // same stale-closure bug that affected the cast button and main engine.
    const dlnaPlayerRef = useRef(dlnaPlayer);
    dlnaPlayerRef.current = dlnaPlayer;
    const { currentStreamUrl, stationName } = useRadioPlayer();
    const { setVolume } = usePlayerActions();
    const isMuted = usePlayerMuted();
    const volume = usePlayerVolume();
    const lastUrlRef = useRef<null | string>(null);
    useEffect(() => {
        dlnaPlayer?.setRadioMode(true);
        return () => {
            dlnaPlayer?.setRadioMode(false);
            dlnaPlayer?.stop();
            lastUrlRef.current = null;
        };
    }, [dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = (vol: number) => setVolume(vol);
        return dlnaPlayer.on('rendererDlnaVolume', handler);
    }, [setVolume, dlnaPlayer, clientKey]);
    useEffect(() => {
        if (!dlnaPlayer) return;
        const handler = (state: string) => {
            if (state === 'STOPPED' || state === 'PAUSED_PLAYBACK') {
                useRadioStore.getState().actions.stop();
            }
        };
        return dlnaPlayer.on('rendererDlnaTransportState', handler);
    }, [dlnaPlayer, clientKey]);
    const { isPlaying } = useRadioPlayer();
    const isInitialMountRef = useRef(true);
    useEffect(() => {
        if (isInitialMountRef.current) {
            isInitialMountRef.current = false;
            return;
        }
        if (!isPlaying) {
            dlnaPlayerRef.current?.stop();
            useRadioStore.getState().actions.stop();
        }
    }, [isPlaying]);
    useEffect(() => {
        const client = dlnaPlayerRef.current;
        if (!client || !currentStreamUrl) return;
        if (currentStreamUrl === lastUrlRef.current) return;
        lastUrlRef.current = currentStreamUrl;
        client.playUrl(currentStreamUrl, { title: stationName || 'Radio' });
    }, [currentStreamUrl, stationName]);
    useEffect(() => {
        dlnaPlayerRef.current?.volume(volume);
    }, [volume]);
    useEffect(() => {
        dlnaPlayerRef.current?.mute(isMuted);
    }, [isMuted]);
    return <div id="radio-dlna-player" style={{ display: 'none' }} />;
}
