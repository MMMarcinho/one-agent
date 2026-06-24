import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

export default defineConfig({
  root: resolve(here, 'renderer'),
  base: './', // load via file:// in the packaged app
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'src/desktop/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: resolve(repoRoot, 'dist/desktop/renderer'),
    emptyOutDir: true,
  },
});
