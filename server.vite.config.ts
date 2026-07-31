/**
 * Vite config for the standalone casting server (`src/server/index.ts`).
 *
 * Produces a single Node.js bundle at `out/server/index.js` with all
 * application code inlined. Only the runtime dependency (`ws`) and
 * Node.js built-ins are externalized — everything else is bundled so
 * the production image needs only `ws` installed at runtime.
 *
 * The server is a plain Node app — no Electron, no browser, no preload.
 * Built modules: src/server, src/shared (type-only), and (future) the
 * extracted DLNA helpers under src/main/features/core/dlna/. The aliases
 * below mirror tsconfig.node.json so the build resolves the same paths
 * the typechecker sees.
 */
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
    build: {
        emptyOutDir: true,
        lib: {
            entry: path.resolve(__dirname, 'src/server/index.ts'),
            fileName: () => 'index.js',
            formats: ['cjs'],
            name: 'feishin-casting-server',
        },
        minify: 'esbuild',
        outDir: path.resolve(__dirname, './out/server'),
        rollupOptions: {
            external: [
                'ws',
                'events',
                'http',
                'https',
                'fs',
                'os',
                'path',
                'crypto',
                'child_process',
                'dgram',
                'net',
                'url',
            ],
        },
        sourcemap: true,
        target: 'node20',
    },
    resolve: {
        alias: {
            '/@/server': path.resolve(__dirname, './src/server'),
            '/@/shared': path.resolve(__dirname, './src/shared'),
        },
    },
});
