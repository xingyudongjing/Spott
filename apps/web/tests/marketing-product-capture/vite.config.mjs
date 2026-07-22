import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";

export const productCaptureAppRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const productCaptureViteConfig = {
  configFile: false,
  define: {
    "process.env.NEXT_PUBLIC_MAP_STYLE_URL": JSON.stringify(""),
  },
  logLevel: "error",
  plugins: [react()],
  resolve: {
    alias: {
      "next/image": path.join(productCaptureAppRoot, "tests", "marketing-product-capture", "NextImageStub.tsx"),
      "next/link": path.join(productCaptureAppRoot, "tests", "marketing-product-capture", "NextLinkStub.tsx"),
      "next/navigation": path.join(productCaptureAppRoot, "tests", "marketing-product-capture", "NextNavigationStub.ts"),
    },
  },
  root: productCaptureAppRoot,
};

export default defineConfig(productCaptureViteConfig);
