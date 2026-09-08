import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

// Dev-only: lets the in-page GIF recorder POST bytes to disk (docs/demo.gif).
function saveGifPlugin(): Plugin {
  return {
    name: "save-gif",
    configureServer(server) {
      server.middlewares.use("/__save", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end();
        }
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const out = resolve(process.cwd(), "docs/demo.gif");
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, Buffer.concat(chunks));
          res.statusCode = 200;
          res.end("ok");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), saveGifPlugin()],
  server: {
    port: 5199,
    proxy: { "/api": "http://localhost:8790" },
  },
  test: {
    include: ["src/**/*.test.ts"], // backend has its own vitest (cwd-sensitive .env)
    environment: "node",
  },
});
