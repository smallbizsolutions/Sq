import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/menu": "http://localhost:5175",
      "/checkout": "http://localhost:5175"
    }
  }
});
