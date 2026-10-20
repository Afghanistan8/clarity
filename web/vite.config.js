import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Local development aid: same-origin proxy to the Studionet RPC, used
    // only when localStorage["clarity.rpc"] is set (e.g. by the local e2e
    // harness). Production is unaffected — it always talks to the RPC
    // directly and simply retries while the (flaky) CORS headers heal.
    proxy: {
      "/api-proxy": {
        target: "https://studio.genlayer.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api-proxy/, ""),
      },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
