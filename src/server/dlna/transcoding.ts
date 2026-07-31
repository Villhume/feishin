/**
 * ffmpeg-based speed transcoding for DLNA playback.
 *
 * Extracted from src/main/features/core/dlna/index.ts so the same logic
 * serves both the Electron IPC adapter and the standalone casting server.
 *
 * Produces MP3 files in the OS temp dir, served back to the device via
 * the EventServer's `/serve-temp` endpoint.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, promises as fsPromises, readdirSync, unlinkSync } from 'fs';
import os from 'os';
import path from 'path';

import type { DlnaDevice } from '/@/shared/types/dlna';

import type { EventServer } from './event-server';

export interface TranscoderLogger {
    info: (action: string, err?: unknown) => void;
}

export interface TranscoderCallbacks {
    /** Called when ffmpeg is missing and a speed change was requested. */
    onFfmpegMissing: () => void;
    /** Pick the host LAN IP that the device should use to reach us. */
    getLanIp: () => null | string;
    /** Pick the LAN IP on the same /24 subnet as the given device IP. */
    getLanIpForDevice: (deviceIp: string) => null | string;
    /** Currently-connected device (used to choose the right LAN IP). Null if not connected. */
    getConnectedDevice: () => DlnaDevice | null;
    /** Event server that serves transcoded files to the device. */
    eventServer: EventServer;
}

export interface PrepareSpeedFileData {
    offset?: number;
    preservePitch: boolean;
    speed: number;
    url: string;
}

export interface CheckSpeedFileData {
    preservePitch: boolean;
    speed: number;
    url: string;
}

export class Transcoder {
    private currentFfmpegProcess: ChildProcess | null = null;
    private currentTranscodeFile = '';
    private speedProxyProcess: ChildProcess | null = null;
    private ffmpegAvailable: boolean | null = null;

    constructor(
        private readonly logger: TranscoderLogger,
        private readonly callbacks: TranscoderCallbacks,
    ) {
        this.cleanupTempFiles();
    }

    /** Remove leftover dlna-speed-*.mp3 files from previous runs. */
    cleanupTempFiles(): void {
        try {
            const tmpDir = os.tmpdir();
            const files = readdirSync(tmpDir);
            for (const file of files) {
                if (file.startsWith('dlna-speed-') && file.endsWith('.mp3')) {
                    unlinkSync(path.join(tmpDir, file));
                }
            }
        } catch (err) {
            this.logger.info('Failed to cleanup temp files', err);
        }
    }

    /** Kill any active ffmpeg transcode and delete its temp file. */
    stopCurrentTranscode(): void {
        if (this.currentFfmpegProcess) {
            this.logger.info('Stopping active transcode process');
            try {
                this.currentFfmpegProcess.kill('SIGKILL');
            } catch (err) {
                this.logger.info('Failed to kill ffmpeg', err);
            }
            this.currentFfmpegProcess = null;
        }
        if (this.currentTranscodeFile) {
            try {
                if (existsSync(this.currentTranscodeFile)) {
                    unlinkSync(this.currentTranscodeFile);
                    this.logger.info('Deleted transcode temp file');
                }
            } catch {
                // File errors
            }
            this.currentTranscodeFile = '';
        }
    }

    /** Kill the (legacy) speed proxy process if any. */
    stopSpeedProxy(): void {
        if (this.speedProxyProcess) {
            try {
                this.speedProxyProcess.kill('SIGKILL');
            } catch {
                // Catch
            }
            this.speedProxyProcess = null;
        }
    }

    /** Lazy ffmpeg presence check (cached). */
    hasFfmpeg(): boolean {
        if (this.ffmpegAvailable === null) {
            try {
                execSync('ffmpeg -version', { stdio: 'ignore' });
                this.ffmpegAvailable = true;
            } catch {
                this.ffmpegAvailable = false;
            }
        }
        return this.ffmpegAvailable;
    }

    /** Resolve which LAN IP the device should use to reach us, preferring
     *  the connected device's subnet. Returns null if no LAN IP found. */
    private resolveLanIp(): null | string {
        const device = this.callbacks.getConnectedDevice();
        if (device) {
            try {
                const deviceIp = new URL(device.controlUrl).hostname;
                const matched = this.callbacks.getLanIpForDevice(deviceIp);
                if (matched) return matched;
            } catch {
                // Catch
            }
        }
        return this.callbacks.getLanIp();
    }

    async prepareSpeedFile(data: PrepareSpeedFileData): Promise<null | string> {
        this.stopCurrentTranscode();
        if (!this.hasFfmpeg()) {
            this.logger.info('FFmpeg not found on PATH');
            this.callbacks.onFfmpegMissing();
            return null;
        }
        const lanIp = this.resolveLanIp();
        if (!lanIp) return null;
        await this.callbacks.eventServer.ensureStarted();
        const safeUrlId = createHash('md5').update(data.url).digest('hex').substring(0, 16);
        const pp = data.preservePitch ? '1' : '0';
        const fileName = `dlna-speed-${safeUrlId}-s${data.speed}-p${pp}.mp3`;
        const filePath = path.join(os.tmpdir(), fileName);
        this.currentTranscodeFile = filePath;
        return new Promise<null | string>((resolve) => {
            try {
                let audioFilter = '';
                if (data.speed !== 1) {
                    if (!data.preservePitch) {
                        const targetRate = Math.round(44100 * data.speed);
                        audioFilter = `aresample=44100,asetrate=${targetRate},aresample=44100`;
                    } else {
                        const parts: string[] = [];
                        let remaining = data.speed;
                        while (remaining > 2) {
                            parts.push('atempo=2.0');
                            remaining /= 2;
                        }
                        while (remaining < 0.5) {
                            parts.push('atempo=0.5');
                            remaining /= 0.5;
                        }
                        parts.push(`atempo=${remaining.toFixed(6)}`);
                        audioFilter = parts.join(',');
                    }
                }
                this.logger.info(`Transcode started for speed: ${data.speed}`);
                const ffmpeg = spawn('ffmpeg', [
                    '-loglevel',
                    'error',
                    '-i',
                    data.url,
                    '-vn',
                    '-af',
                    audioFilter || 'anull',
                    '-map_metadata',
                    '0',
                    '-f',
                    'mp3',
                    this.currentTranscodeFile,
                ]);
                this.currentFfmpegProcess = ffmpeg;
                ffmpeg.on('error', (err) => {
                    this.logger.info('FFmpeg spawn error', err);
                    this.currentFfmpegProcess = null;
                    resolve(null);
                });
                ffmpeg.on('close', (code) => {
                    this.currentFfmpegProcess = null;
                    if (code === 0) {
                        this.logger.info('Transcode finished successfully');
                        resolve(this.callbacks.eventServer.serveTempUrl(this.currentTranscodeFile, lanIp));
                    } else {
                        this.logger.info(`FFmpeg exited with code ${code}`);
                        resolve(null);
                    }
                });
            } catch (err) {
                this.logger.info('Transcode setup failed', err);
                resolve(null);
            }
        });
    }

    async checkSpeedFile(data: CheckSpeedFileData): Promise<null | string> {
        const lanIp = this.resolveLanIp();
        if (!lanIp) return null;
        const safeUrlId = createHash('md5').update(data.url).digest('hex').substring(0, 16);
        const pp = data.preservePitch ? '1' : '0';
        const fileName = `dlna-speed-${safeUrlId}-s${data.speed}-p${pp}.mp3`;
        const filePath = path.join(os.tmpdir(), fileName);
        try {
            await fsPromises.access(filePath);
            return this.callbacks.eventServer.serveTempUrl(filePath, lanIp);
        } catch {
            return null;
        }
    }
}
