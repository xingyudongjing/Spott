import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "media.spott.jp",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
