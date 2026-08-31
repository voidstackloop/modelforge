import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// No viteSingleFile() here — unlike frontend/ (bundled into one static HTML
// file for Electron), this is a normally-deployed multi-chunk SPA.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Docker development uses the same browser-facing /api path as the
    // production Nginx image. Outside Docker this stays disabled unless the
    // developer opts in with VITE_API_PROXY_TARGET.
    proxy: process.env.VITE_API_PROXY_TARGET
      ? {
          "/api": {
            target: process.env.VITE_API_PROXY_TARGET,
            changeOrigin: true,
            rewrite: (requestPath) => requestPath.replace(/^\/api/, ""),
          },
        }
      : undefined,
  },
});

