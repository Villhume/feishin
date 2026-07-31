import isElectron from 'is-electron';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useDlnaClientContext } from '/@/renderer/features/player/api/use-dlna-client';
import {
    SettingOption,
    SettingsSection,
} from '/@/renderer/features/settings/components/settings-section';
import { useCastSettings, useSettingsStoreActions } from '/@/renderer/store/settings.store';
import { Group } from '/@/shared/components/group/group';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { Textarea } from '/@/shared/components/textarea/textarea';

/**
 * Settings for the standalone casting server.
 *
 * In Electron, the in-process IPC bridge is always used when mode ≠ 'off',
 * so `servers` and `authToken` are irrelevant — they're hidden in that
 * environment. The mode toggle is still useful: setting it to 'off'
 * disables the DLNA player entirely (no IPC bridge).
 *
 * In web/Docker, all three fields drive the WsDlnaClient:
 *   - mode='off'      → DLNA unavailable
 *   - mode='auto'     → probe ws://${location.hostname}:8180 (Phase 8 will
 *                       extend this to walk fallback ports)
 *   - mode='manual'   → connect to the first reachable URL in `servers`
 *   - servers         → always used as a fallback list when auto fails
 *   - authToken       → sent as ?token=<value> on the WS upgrade
 */
export const CastSettings = memo(() => {
    const { t } = useTranslation();
    const cast = useCastSettings();
    const { setSettings } = useSettingsStoreActions();
    const { error, status } = useDlnaClientContext();

    const statusKey = `castStatus_${status}`;
    const statusText = t(`setting.${statusKey}`, {
        defaultValue: status,
    });

    const handleSetMode = (mode: 'auto' | 'manual' | 'off') => {
        setSettings({ cast: { mode } });
    };

    const handleSetServers = (data: string[]) => {
        setSettings({ cast: { servers: data } });
    };

    const handleSetAuthToken = (authToken: string) => {
        setSettings({ cast: { authToken: authToken || undefined } });
    };

    const options: SettingOption[] = [
        {
            control: (
                <Select
                    data={[
                        { label: t('setting.castMode_off'), value: 'off' },
                        { label: t('setting.castMode_auto'), value: 'auto' },
                        { label: t('setting.castMode_manual'), value: 'manual' },
                    ]}
                    defaultValue={cast.mode}
                    onChange={(e) => e && handleSetMode(e as 'auto' | 'manual' | 'off')}
                    width={200}
                />
            ),
            description: t('setting.castMode', { context: 'description' }),
            title: t('setting.castMode'),
        },
        {
            control: (
                <Group gap="sm">
                    <Text isMuted size="sm">
                        {statusText}
                    </Text>
                    {error && (
                        <Text isMuted size="sm">
                            — {error}
                        </Text>
                    )}
                </Group>
            ),
            description: t('setting.cast', { context: 'description' }),
            isHidden: isElectron(),
            title: t('setting.cast'),
        },
        {
            control: (
                <Stack gap="xs">
                    <Textarea
                        autosize
                        defaultValue={cast.servers.join('\n')}
                        minRows={3}
                        onBlur={(e) =>
                            handleSetServers(
                                e.currentTarget.value
                                    .split('\n')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                            )
                        }
                        placeholder="ws://192.168.1.10:8180"
                        width={300}
                    />
                </Stack>
            ),
            description: t('setting.castServers', { context: 'description' }),
            isHidden: isElectron() || cast.mode === 'off',
            title: t('setting.castServers'),
        },
        {
            control: (
                <TextInput
                    defaultValue={cast.authToken ?? ''}
                    onBlur={(e) => handleSetAuthToken(e.currentTarget.value)}
                    placeholder="(none)"
                    width={300}
                />
            ),
            description: t('setting.castAuthToken', { context: 'description' }),
            isHidden: isElectron() || cast.mode === 'off',
            title: t('setting.castAuthToken'),
        },
    ];

    return <SettingsSection options={options} title={t('page.setting.cast')} />;
});
