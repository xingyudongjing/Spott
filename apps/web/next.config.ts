import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "media.spott.jp",
        pathname: "/**",
      },
      {
        // Development seed event covers only; production media stays on media.spott.jp.
        protocol: "https",
        hostname: "picsum.photos",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "fastly.picsum.photos",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
