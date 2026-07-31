/**
 * DLNA/UPnP shared types.
 *
 * Single source of truth for all DLNA-related types used across the main
 * process, preload, renderer, and the standalone casting server. Extracted
 * from the previously duplicated definitions in:
 *   - src/main/features/core/dlna/soap-client.ts
 *   - src/preload/dlna-player.ts
 *   - src/renderer/features/player/components/dlna/types.ts
 */

export interface DlnaDevice {
    controlUrl: string;
    groupCoordinatorId?: string;
    groupMembers?: DlnaDevice[];
    id: string;
    isPair?: boolean;
    location: string;
    name: string;
    renderingControlUrl: string;
}

export interface GroupMember {
    device: DlnaDevice;
    isCoordinator: boolean;
    volume: number;
}

export interface TrackMetadata {
    albumArtUrl?: string;
    albumName?: string;
    artistName?: string;
    autoPlay?: boolean;
    duration?: number;
    mimeType?: string;
    title: string;
}

export interface SpeakerProperties {
    bass: number;
    crossfade: boolean;
    ledState: boolean;
    loudness: boolean;
    touchControls: boolean;
    treble: number;
}

/** Result shape returned by `connect()`. Matches the previous inline return type. */
export interface ConnectResult {
    currentDuration: number;
    currentPosition: number;
    currentTransportState: string;
    currentUri: string;
    nextUri: string;
    success: boolean;
    volume: number;
}

/** Payload for the `rendererDlnaConnectPlayback` event. */
export interface ConnectPlaybackInfo {
    duration: number;
    nextUri: string;
    position: number;
    transportState: string;
    uri: string;
}

/** Payload for the `rendererDlnaToast` event. */
export interface DlnaToastPayload {
    message: string;
    type: 'error' | 'info' | 'warning';
}

/** Payload for the `rendererDlnaGroupMemberVolume` event. */
export interface GroupMemberVolumePayload {
    deviceId: string;
    volume: number;
}

/** Argument shape for `prepareSpeedFile` / `checkSpeedFile`. */
export interface SpeedFileData {
    offset?: number;
    preservePitch: boolean;
    speed: number;
    url: string;
}
