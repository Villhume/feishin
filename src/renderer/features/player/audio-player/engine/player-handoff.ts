export const playerHandoff = {
    deviceAlreadyPlaying: false,
    deviceCurrentUri: '',
    /** Next URI from the device at connect time.  Used by the mount
     *  effect to reconstruct the queue match that the (dropped)
     *  `rendererDlnaConnectPlayback` event handler would have done. */
    deviceNextUri: '',
    /** Position (seconds) reported by the device at connect time. */
    devicePosition: 0,
    /** Transport state reported by the device at connect time
     *  ('PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' | '').  The mount
     *  effect uses this to decide whether to call mediaPlay()
     *  directly, because the `rendererDlnaConnectPlayback` event
     *  is emitted by the server *before* the connect RPC result
     *  returns — which means the event listener (registered in a
     *  separate effect after mount) hasn't been wired up yet and
     *  the event is silently dropped by the WS client. */
    deviceTransportState: '',
    deviceWasPaused: false,
    pendingDlnaSeek: -1,
    pendingLocalSeek: -1,
};
