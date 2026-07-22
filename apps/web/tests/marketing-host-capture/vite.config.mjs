import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

export const captureAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const captureViteConfig = {
  configFile: false,
  logLevel: "error",
  plugins: [react()],
  resolve: {
    alias: {
      "next/link": path.join(captureAppRoot, "tests", "marketing-host-capture", "NextLinkStub.tsx"),
    },
  },
  root: captureAppRoot,
};

export default defineConfig(captureViteConfig);
