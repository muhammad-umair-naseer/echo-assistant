import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    proxy: { "/api": "http://localhost:8790" },
  },
  test: {
    include: ["src/**/*.test.ts"], // backend has its own vitest (cwd-sensitive .env)
    environment: "node",
  },
});
