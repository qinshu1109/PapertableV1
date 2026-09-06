import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/ui/",
  plugins: [react()],
  build: {
    outDir: "../app/memos_managed_mcp/ui_dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/ui/api": "http://127.0.0.1:8002",
      "/healthz": "http://127.0.0.1:8002",
    },
  },
});
