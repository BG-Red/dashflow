import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  // `bun run build:demo` produces the GitHub Pages bundle: mock API, repo-relative base path.
  base: process.env.DEMO_BASE ?? "/",
  define: { "import.meta.env.VITE_MOCK_API": JSON.stringify(mode === "demo" ? "1" : "0") },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API (and its dev-mode fake identity) lives in the Bun server.
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
  build: { outDir: mode === "demo" ? "dist-demo" : "dist", sourcemap: false, chunkSizeWarningLimit: 1600 },
}));
