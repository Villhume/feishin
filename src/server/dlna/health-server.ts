/**
 * Minimal HTTP server that exposes `/health` and acts as the upgrade target
 * for the WebSocket transport.  In the standalone casting server, this same
 * `http.Server` is also the host for the EventServer's `/serve-temp`,
 * `/notify`, and `/topology` routes (attached via `prependListener` from
 * `EventServer.ensureStarted`) — sharing the port lets Sonos devices fetch
 * speed-transcoded files via the same firewall-allowlisted port as the WS
 * connection (e.g. 8180), instead of a random high port that Windows
 * Firewall blocks by default.
 */
import http from 'http';

export interface HealthResponse {
    ok: boolean;
    version: string;
    ffmpegPresent: boolean;
    connected: boolean;
}

export interface HealthServerOptions {
    logger: { info: (action: string, err?: unknown) => void };
    getHealth: () => HealthResponse;
}

export interface HealthServer {
    server: http.Server;
    stop: () => void;
}

export function createHealthServer(opts: HealthServerOptions): HealthServer {
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
            try {
                const body = JSON.stringify(opts.getHealth());
                res.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store',
                    'Content-Length': Buffer.byteLength(body),
                    'Content-Type': 'application/json',
                });
                res.end(body);
            } catch (err) {
                opts.logger.info('health response failed', err);
                res.writeHead(500);
                res.end();
            }
            return;
        }
        // Anything else: 404. The WebSocket upgrade is handled by the WS
        // server attached to this HTTP server (not by this request handler).
        res.writeHead(404);
        res.end();
    });
    return {
        server,
        stop: () => {
            try {
                server.closeAllConnections?.();
                server.close();
            } catch (err) {
                opts.logger.info('HTTP server close failed', err);
            }
        },
    };
}
