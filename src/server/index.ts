/**
 * Standalone DLNA casting server entry point.
 *
 * Env:
 *   PORT                    Listen port (default 8180)
 *   AUTH_TOKEN              Optional bearer token; if set, clients must send
 *                           `Authorization: Bearer <token>` on the WS upgrade.
 *   FFMPEG_PATH             Optional ffmpeg binary path; defaults to `ffmpeg` on PATH.
 *   OVERRIDE_LAN_IP         Optional host IP the device should use to reach us
 *                           (useful in Docker bridge mode where the container's
 *                           own IP is unreachable from the host LAN).
 *   DISABLE_EVENT_SUBSCRIPTION  If `true`, skip UPnP event subscription
 *                               (useful in Docker bridge mode where devices
 *                               cannot reach our callback URL). Polls instead.
 *   LOG_LEVEL               Not yet implemented (logs are info-level to stdout).
 *
 * Routes:
 *   GET  /health   ─ `{ ok: true, version, ffmpeg: boolean, connected: boolean }`
 *   WS   /         ─ casting protocol (see src/shared/types/cast-types.ts)
 */
import { createHealthServer } from './dlna/health-server';
import { createController } from './dlna/controller-factory';
import { WsTransport } from './transports/ws-transport';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT ?? 8180);
const AUTH_TOKEN = process.env.AUTH_TOKEN || undefined;
const FFMPEG_PATH = process.env.FFMPEG_PATH || undefined;
const OVERRIDE_LAN_IP = process.env.OVERRIDE_LAN_IP || undefined;
const DISABLE_EVENT_SUBSCRIPTION = process.env.DISABLE_EVENT_SUBSCRIPTION === 'true';

const log = (action: string, err?: unknown) => {
    if (err) {
        // eslint-disable-next-line no-console
        console.error(`[Casting] ${action}`, err);
    } else {
        // eslint-disable-next-line no-console
        console.log(`[Casting] ${action}`);
    }
};

async function main(): Promise<void> {
    // A late-bound reference so the health server can query the controller
    // after it's constructed.  Until then, `getHealth` reports the
    // "not yet booted" state (`connected: false`, `ffmpegPresent: false`).
    let controllerRef: Awaited<ReturnType<typeof createController>> | null = null;

    const healthServer = createHealthServer({
        logger: { info: log },
        getHealth: () => ({
            connected: controllerRef?.isConnected() ?? false,
            ffmpegPresent: controllerRef?.hasFfmpeg() ?? false,
            ok: true,
            version: '1',
        }),
    });

    const controller = await createController({
        disableEventSubscription: DISABLE_EVENT_SUBSCRIPTION,
        // Attach the EventServer's `/serve-temp`, `/notify`, `/topology`
        // routes to the main HTTP server on port 8180 — this lets Sonos
        // devices fetch speed-transcoded files via the same firewall-
        // allowlisted port the WS connection uses, instead of a random
        // high port that Windows Firewall blocks by default.
        eventServerHttp: { server: healthServer.server, port: PORT },
        ffmpegPath: FFMPEG_PATH,
        overrideLanIp: OVERRIDE_LAN_IP,
        logger: { info: log },
    });
    controllerRef = controller;

    const wss = new WebSocketServer({ server: healthServer.server });

    const transport = new WsTransport(wss, controller, {
        authToken: AUTH_TOKEN,
        logger: { info: log },
        hasFfmpeg: () => controller.hasFfmpeg(),
    });

    transport.bindControllerEvents(controller);

    healthServer.server.listen(PORT, () => {
        log(`Casting server listening on http://0.0.0.0:${PORT}`);
        log(`  ffmpeg: ${controller.hasFfmpeg() ? 'found' : 'missing (speed transcoding disabled)'}`);
        log(`  auth:   ${AUTH_TOKEN ? 'bearer token required' : 'open (no auth)'}`);
    });

    const shutdown = async () => {
        log('Shutting down…');
        try {
            await controller.disconnect();
        } catch (err) {
            log('Error during controller disconnect', err);
        }
        transport.close();
        healthServer.server.close();
        wss.close();
        setTimeout(() => process.exit(0), 500);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

main().catch((err) => {
    log('Fatal startup error', err);
    process.exit(1);
});
