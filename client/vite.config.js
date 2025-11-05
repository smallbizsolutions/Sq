import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const isDev = process.env.NODE_ENV !== "production";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev-only proxy; in prod we use VITE_API_BASE
    proxy: isDev
      ? {
          "/menu": "http://localhost:5175",
          "/checkout": "http://localhost:5175"
        }
      : undefined
  }
});
