import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-server proxy: the RACP auth endpoints and WebSocket live on the pi-host
// HTTP server (default port 8080). Same-origin cookies require the proxy so
// `fetch('/v1/...', {credentials:'same-origin'})` works in dev.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8080",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
