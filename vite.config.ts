import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "mediapipe-local-wasm",
      configureServer(server) {
        const wasmDir = path.resolve(
          __dirname,
          "node_modules/@mediapipe/tasks-vision/wasm"
        );
        server.middlewares.use("/mediapipe-wasm", (req, res, next) => {
          const filePath = path.join(wasmDir, req.url ?? "");
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            res.setHeader("Cache-Control", "public, max-age=86400");
            server.ssrLoadModule;
            const ext = path.extname(filePath);
            if (ext === ".wasm") res.setHeader("Content-Type", "application/wasm");
            else if (ext === ".js") res.setHeader("Content-Type", "application/javascript");
            fs.createReadStream(filePath).pipe(res);
          } else {
            next();
          }
        });
      }
    }
  ],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp"
    },
    proxy: {
      "/mediapipe-model": {
        target: "https://storage.googleapis.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mediapipe-model/, "")
      }
    }
  },
  worker: {
    format: "es"
  }
});
