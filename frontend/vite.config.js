import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Points at the new layered backend/ app by default.
// Set VITE_API_PROXY_TARGET=http://127.0.0.1:7070 to fall back to the legacy app instead.
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:6969";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist"
  }
});
