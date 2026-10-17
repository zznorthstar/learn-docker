import { defineConfig } from 'vite';

// `npm run dev` serves the UI; run the relay (`npm run dev:relay`, default :8787)
// next to it. If 8787 is taken on your machine: RELAY_PORT=8799 npm run dev:relay
// and RELAY_PORT=8799 npm run dev
const relay = `http://127.0.0.1:${process.env.RELAY_PORT ?? 8787}`;

export default defineConfig({
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 },
  server: {
    proxy: {
      '/mcp': relay,
      '/health': relay,
      '/ws': { target: relay, ws: true },
    },
  },
});
