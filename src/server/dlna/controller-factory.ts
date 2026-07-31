import http from 'http';
import type { ControllerLike } from './types';

/**
 * Factory that builds the DlnaController for the standalone casting server
 * (and, in a follow-up step, for the Electron main process IPC shim).
 *
 * The controller lives in `controller.ts`. This factory exists so that
 * `src/server/index.ts` doesn't import the controller class directly —
 * keeping the entry point small and making the boundary between
 * "transport layer" and "controller" explicit.
 */
import { DlnaController } from './controller';

export interface ControllerConfig {
    disableEventSubscription: boolean;
    /**
     *  External HTTP server to attach the EventServer's routes to.
     *  When provided, the EventServer serves `/serve-temp`, `/notify`,
     *  and `/topology` on this server's port (rather than a random
     *  high port that firewalls may block).  Required for the
     *  standalone casting server so Sonos devices can fetch speed-
     *  transcoded files via port 8180 (firewall-allowlisted).
     */
    eventServerHttp?: { server: http.Server; port: number };
    ffmpegPath?: string;
    logger: { info: (action: string, err?: unknown) => void };
    overrideLanIp?: string;
}

export async function createController(config: ControllerConfig): Promise<ControllerLike> {
    return new DlnaController(config);
}
