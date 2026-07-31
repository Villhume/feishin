/**
 * Network helpers for DLNA — pure functions with no module-level state.
 *
 * Extracted from src/main/features/core/dlna/index.ts so the same logic
 * serves both the Electron IPC adapter and the standalone casting server.
 */
import os from 'os';

/** Optional override for the host IP that DLNA devices should use to reach back
 *  to us (for event callbacks and the speed-transcode file server). Used in
 *  Docker bridge mode where the container's auto-detected IP is unreachable
 *  from the host LAN. */
export function createNetworkHelpers(opts: {
    overrideLanIp?: string;
} = {}) {
    const override = opts.overrideLanIp?.trim();

    function getLanIp(): null | string {
        if (override) return override;
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
        return null;
    }

    function getLanIpForDevice(deviceIp: string): null | string {
        if (override) return override;
        try {
            const devOctets = deviceIp.split('.');
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const iface of interfaces[name] || []) {
                    if (iface.family !== 'IPv4' || iface.internal) continue;
                    const ifOctets = iface.address.split('.');
                    if (
                        ifOctets[0] === devOctets[0] &&
                        ifOctets[1] === devOctets[1] &&
                        ifOctets[2] === devOctets[2]
                    ) {
                        return iface.address;
                    }
                }
            }
        } catch {
            // LAN IP may be malformed, etc
        }
        return getLanIp();
    }

    function rewriteUrlForLan(url: string): string {
        const lanIp = getLanIp();
        if (!lanIp) return url;
        return url
            .replace(/http:\/\/localhost(:\d+)/, `http://${lanIp}$1`)
            .replace(/http:\/\/127\.0\.0\.1(:\d+)/, `http://${lanIp}$1`)
            .replace(/http:\/\/\[::1\](:\d+)/, `http://${lanIp}$1`)
            .replace(/http:\/\/\[::\](:\d+)/, `http://${lanIp}$1`);
    }

    return { getLanIp, getLanIpForDevice, rewriteUrlForLan };
}

export type NetworkHelpers = ReturnType<typeof createNetworkHelpers>;
