/**
 * HTTP server that serves two roles for DLNA:
 *   1. Speed-transcoded file serving (`GET/HEAD /serve-temp?path=<file>` with HTTP Range support).
 *   2. UPnP event callbacks from Sonos/devices (`NOTIFY /notify` and `NOTIFY /topology`).
 *
 * Extracted from src/main/features/core/dlna/index.ts:ensureEventServer() so the
 * same logic serves both the Electron IPC adapter and the standalone casting server.
 */
import { createReadStream, statSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

export interface EventServerCallbacks {
    /** Called when any other `NOTIFY /*` request arrives (AVTransport events). */
    onNotify: (body: string) => void;
    /** Called when a `NOTIFY /topology` request arrives (Sonos ZoneGroupTopology events). */
    onTopology: (body: string) => void;
}

export interface EventServerLogger {
    info: (action: string, err?: unknown) => void;
}

export interface EventServerOptions {
    callbacks: EventServerCallbacks;
    logger: EventServerLogger;
    /**
     *  External HTTP server to attach `/serve-temp`, `/notify`, and
     *  `/topology` routes to.  When provided, EventServer does NOT create
     *  its own `http.Server` or pick a random port — it installs its
     *  request handler on the existing server via `prependListener` and
     *  uses `fixedPort` for building device-facing URLs.
     *
     *  This is the production path for the standalone casting server:
     *  routing through the main port (e.g. 8180, already allowlisted
     *  through Windows Firewall) avoids the issue where Sonos devices
     *  cannot reach a random high port that the firewall blocks.
     *
     *  When omitted (Electron IPC path), EventServer falls back to its
     *  own `http.createServer` listening on port 0 — the historical
     *  behavior.
     */
    externalServer?: http.Server;
    /** Port the external server listens on. Required when externalServer is set. */
    fixedPort?: number;
}

export class EventServer {
    /** Current listening port. 0 if not started. */
    get port(): number {
        return this.portNumber;
    }
    private portNumber = 0;

    private server: http.Server | null = null;

    /**
     *  When operating in "external server" mode, this holds the bound
     *  request listener so it can be removed cleanly on `stop()`.
     *  `null` in self-owned-server mode (where we own `server.close()`).
     */
    private externalRequestListener: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;

    private readonly ownsServer: boolean;

    constructor(private readonly opts: EventServerOptions) {
        this.ownsServer = !opts.externalServer;
    }

    /**
     *  Lazily start the server.
     *
     *  - In **external server** mode: installs the request handler on the
     *    provided `http.Server` via `prependListener` so `/serve-temp`,
     *    `/notify`, and `/topology` are handled before the host server's
     *    own 404 fallback.  Records `fixedPort` so device-facing URLs
     *    use the main port (e.g. 8180, firewall-allowlisted).
     *  - In **self-owned** mode: creates a new `http.Server` listening on
     *    port 0 (random).  This is the legacy path used by the Electron
     *    IPC shim, where the controller has no shared HTTP server.
     */
    async ensureStarted(): Promise<void> {
        if (this.server) return;

        if (this.opts.externalServer) {
            const fixedPort = this.opts.fixedPort;
            if (!fixedPort) {
                throw new Error('EventServer.externalServer requires fixedPort');
            }
            const external = this.opts.externalServer;
            const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
                this.handleRequest(req, res);
            };
            // `prependListener` so this runs before the host server's own
            // 'request' handler (typically a 404 fallback for non-`/health`
            // paths in health-server.ts).  `handleRequest` returns without
            // responding for unmatched paths, letting the next listener
            // (the health server's `/health` + 404 handler) take over.
            external.prependListener('request', handler);
            this.externalRequestListener = handler;
            this.server = external;
            this.portNumber = fixedPort;
            this.opts.logger.info(`EventServer attached to existing HTTP server on port ${fixedPort}`);
            return;
        }

        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        await new Promise<void>((resolve) => {
            this.server!.listen(0, '0.0.0.0', () => {
                const addr = this.server!.address();
                this.portNumber = typeof addr === 'object' && addr ? addr.port : 0;
                this.opts.logger.info(`Event callback server started on port ${this.portNumber}`);
                resolve();
            });
        });
    }

    /** Build a `/serve-temp/<filename>` URL for the given absolute temp
     *  file path.
     *
     *  The filename (basename only — never a full path) is placed in the
     *  URL **path** rather than as a query parameter.  This is intentional:
     *  some DLNA devices (notably Sonos) appear to reject or fail to fetch
     *  URLs whose query string contains a Windows drive letter or encoded
     *  backslashes (e.g. `?path=C%3A%5CUsers%5C...`).  Even when the
     *  query string is correctly encoded, the device may silently drop
     *  the request without ever contacting the server.  A clean path-style
     *  URL avoids the issue entirely.
     *
     *  The handler (`serveTempFile`) re-resolves the basename against
     *  `os.tmpdir()` and verifies it stays inside the temp directory, so
     *  a malicious basename like `../../etc/passwd` cannot escape. */
    serveTempUrl(filePath: string, lanIp: string): string {
        const base = path.basename(filePath);
        return `http://${lanIp}:${this.portNumber}/serve-temp/${encodeURIComponent(base)}`;
    }

    /**
     *  Stop and reset the server. Safe to call multiple times.
     *
     *  - In **external server mode**: only removes our request listener.
     *    We do NOT call `server.close()` — the host (health server) owns
     *    the socket and is responsible for closing it on shutdown.
     *  - In **self-owned mode**: force-closes any open keep-alive sockets
     *    (e.g. from Sonos NOTIFY delivery) and waits for the underlying
     *    socket to fully release.  Without this, LAN devices with lingering
     *    connections to the old port can interfere with the next subscribe
     *    cycle (the device may stall a new SUBSCRIBE while it still holds
     *    the old subscription context).
     */
    async stop(): Promise<void> {
        if (this.externalRequestListener) {
            this.opts.externalServer?.removeListener(
                'request',
                this.externalRequestListener,
            );
            this.externalRequestListener = null;
        }
        const server = this.server;
        this.server = null;
        this.portNumber = 0;
        if (!server || !this.ownsServer) return;
        try {
            // Node 18.2+: destroy all keep-alive connections immediately
            // so the server's socket is released without waiting for
            // the linger timeout.
            (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        } catch {
            // Ignore — older Node or no open connections
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            // Safety net: if 'close' never fires (e.g., some weird socket
            // bug), don't block the caller indefinitely.
            setTimeout(resolve, 2000);
        });
    }

    /**
     *  Route handler for EventServer's three paths.
     *
     *  In **external server mode**, this is installed via `prependListener`
     *  on the host HTTP server, and unmatched requests fall through to
     *  the next listener (e.g. the health server's `/health` handler +
     *  404 fallback).  We must NOT write a 405/404 for unmatched paths
     *  here, or we'd shadow the host server's routes.
     *
     *  In **self-owned mode**, this is the only handler on its own
     *  `http.Server`, so unmatched paths get the default Node 404.  We
     *  still return without responding for unmatched paths to keep the
     *  behavior identical — the socket will eventually time out or be
     *  closed by the client.
     */
    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // `/serve-temp/<filename>` — speed-transcoded MP3 delivery to Sonos
        if (
            (req.method === 'GET' || req.method === 'HEAD') &&
            req.url != undefined &&
            req.url.startsWith('/serve-temp/')
        ) {
            this.serveTempFile(req, res);
            return;
        }
        // `/notify` and `/topology` — UPnP event callbacks from Sonos
        if (req.method === 'NOTIFY' && req.url != undefined) {
            let body = '';
            req.on('data', (chunk) => (body += chunk.toString()));
            req.on('end', () => {
                res.writeHead(200);
                res.end();
                if (req.url === '/topology') this.opts.callbacks.onTopology(body);
                else this.opts.callbacks.onNotify(body);
            });
            return;
        }
        // Unmatched — in external mode, let the next listener handle it.
        // In self-owned mode, this leaves the socket open; Node's default
        // behavior on a no-handler server is to hang until client timeout,
        // which is fine for a path nobody hits.
        if (this.ownsServer) {
            res.writeHead(404);
            res.end();
        }
        // Else: fall through silently.
    }

    private serveTempFile(req: http.IncomingMessage, res: http.ServerResponse): void {
        try {
            // URL is `/serve-temp/<filename>` (no query string).  Strip the
            // `/serve-temp/` prefix and decode the URL-encoded basename.
            const raw = decodeURIComponent(req.url!.slice('/serve-temp/'.length));
            // Reject any path separators — only allow a plain basename.
            // This blocks `../` traversal attempts; the speed-files are
            // always written by `transcoding.ts` with a flat name like
            // `dlna-speed-{hash}-s{speed}-p{0|1}.mp3`, so there's no
            // legitimate reason for a path separator to appear here.
            if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
                this.opts.logger.info(
                    `serve-temp 403 bad-basename '${raw}' from ${req.socket.remoteAddress}`,
                );
                res.writeHead(403);
                res.end();
                return;
            }
            const tmpDir = os.tmpdir();
            const filePath = path.join(tmpDir, raw);
            const stat = statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;
            this.opts.logger.info(
                `serve-temp ${req.method} from ${req.socket.remoteAddress} file=${raw} size=${fileSize} range=${range || 'none'}`,
            );
            if (req.method === 'HEAD') {
                res.writeHead(200, {
                    'Accept-Ranges': 'bytes',
                    'Content-Length': fileSize,
                    'Content-Type': 'audio/mpeg',
                });
                res.end();
                return;
            }
            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunksize = end - start + 1;
                const file = createReadStream(filePath, { end, start });
                res.writeHead(206, {
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunksize,
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Content-Type': 'audio/mpeg',
                });
                file.pipe(res);
            } else {
                res.writeHead(200, {
                    'Accept-Ranges': 'bytes',
                    'Content-Length': fileSize,
                    'Content-Type': 'audio/mpeg',
                });
                createReadStream(filePath).pipe(res);
            }
        } catch (err) {
            this.opts.logger.info('Static file serve error', err);
            if (!res.writableEnded) {
                res.writeHead(404);
                res.end();
            }
        }
    }
}
