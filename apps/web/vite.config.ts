import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8940",
      "/ws": { target: "ws://localhost:8940", ws: true },
    },
  },
});
