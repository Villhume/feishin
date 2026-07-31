import type { GroupMember } from '/@/shared/types/dlna';

/**
 * Cast-session UI metadata store.
 *
 * Holds the reactive "what's connected, to what, with whom" state that UI
 * components (cast button, volume button, etc.) need to render. The data
 * itself originates from the casting server, but it must be exposed as a
 * synchronous reactive source so components don't depend on component-local
 * state or fragile microtask-timing of WS event delivery.
 *
 * Writers (only these call the actions):
 *   - `dlna-client-provider.tsx` `onHello` / `onClose` / teardown
 *     → `setConnected(...)`, `setGroupMembers(...)`, `clear()`
 *   - `dlna-cast-button.tsx` user actions (connect, group ops, disconnect)
 *     → `setConnected(...)`, `setGroupMembers(...)`, `clear()`
 *
 * Readers: any UI component via `useCastSessionStore((s) => s.<field>)`.
 *
 * Not persisted — DLNA is never restored on reload (PlayerType resets to
 * WEB in `audio-players.tsx` mount effect), so the store starts in the
 * disconnected state on every tab. The `hello` handshake repopulates it
 * within ~100-500ms when a session is already active on the server.
 */
import { create } from 'zustand';

export interface CastCoordinator {
    id: string;
    name: string;
}

export interface CastSessionState {
    /** Display name for the connected device or group. Empty when not
     *  connected, "N speakers" when groupMembers.length > 1, otherwise
     *  the coordinator's name. */
    connectedDeviceName: string;
    /** The coordinator device, or null when not connected. Used by the
     *  cast button to gate "add to group" UI and to filter the expand-
     *  group device list. */
    coordinator: CastCoordinator | null;
    /** Current group members (coordinator first by convention). Empty
     *  array when not connected or when the single-device case applies. */
    groupMembers: GroupMember[];
    /** `true` while this tab is mirroring an active DLNA session. Lags
     *  `PlayerType.DLNA` because PlayerType flips first; the WS `hello`
     *  handler populates this synchronously once the snapshot arrives. */
    isConnected: boolean;
}

export const useCastSessionStore = create<CastSessionState>(() => ({
    connectedDeviceName: '',
    coordinator: null,
    groupMembers: [],
    isConnected: false,
}));

/**
 * Derive the display name and coordinator from a member list. Called by
 * `setGroupMembers` so writers don't have to repeat the derivation.
 *
 * - 0 members → `connectedDeviceName = ''`, `coordinator = null`
 * - 1 member → that member's device name, marked coordinator
 * - >1 members → `"N speakers"` (caller can override by calling
 *   `setConnected` directly with a translated label)
 *
 * The caller may pass a pre-translated `label` to override the `"N
 * speakers"` default — this lets the cast button use `t('dlna.castingToGroup',
 * {count})` when it has access to the i18n hook.
 */
function deriveFromMembers(
    members: GroupMember[],
    label?: string,
): { connectedDeviceName: string; coordinator: CastCoordinator | null } {
    if (members.length === 0) {
        return { connectedDeviceName: '', coordinator: null };
    }
    const coordinatorMember = members.find((m) => m.isCoordinator) ?? members[0];
    const connectedDeviceName =
        members.length > 1
            ? (label ?? `${members.length} speakers`)
            : coordinatorMember.device.name;
    return {
        connectedDeviceName,
        coordinator: {
            id: coordinatorMember.device.id,
            name: coordinatorMember.device.name,
        },
    };
}

export const castSessionActions = {
    /** Clear all session metadata (called on disconnect and teardown). */
    clear(): void {
        useCastSessionStore.setState({
            connectedDeviceName: '',
            coordinator: null,
            groupMembers: [],
            isConnected: false,
        });
    },

    /** Mark the session as connected and populate metadata. `groupMembers`
     *  may be empty (e.g. server hasn't sent group state yet) — `isConnected`
     *  becomes true regardless so the cast button turns blue. */
    setConnected(metadata: {
        connectedDeviceName?: string;
        coordinator?: CastCoordinator | null;
        groupMembers?: GroupMember[];
    }): void {
        const groupMembers = metadata.groupMembers ?? [];
        const derived = deriveFromMembers(groupMembers, metadata.connectedDeviceName);
        useCastSessionStore.setState({
            connectedDeviceName: metadata.connectedDeviceName ?? derived.connectedDeviceName,
            coordinator: metadata.coordinator ?? derived.coordinator,
            groupMembers,
            isConnected: true,
        });
    },

    /** Replace the group member list and re-derive name/coordinator. Callers
     *  that already have a translated label (e.g. the cast button when
     *  building a group) should use `setConnected` instead so the label
     *  wins over the default `"N speakers"` placeholder. */
    setGroupMembers(members: GroupMember[], label?: string): void {
        const derived = deriveFromMembers(members, label);
        useCastSessionStore.setState({
            connectedDeviceName: derived.connectedDeviceName,
            coordinator: derived.coordinator,
            groupMembers: members,
            // Connected status is preserved if it was already true.
            isConnected: useCastSessionStore.getState().isConnected || members.length > 0,
        });
    },
};
