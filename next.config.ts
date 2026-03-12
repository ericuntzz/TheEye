import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Allow large multipart payloads (photo/video training uploads) through
    // middleware proxying and action parsing paths in dev/server runtimes.
    middlewareClientMaxBodySize: "64mb",
    serverActions: {
      bodySizeLimit: "64mb",
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
};

export default nextConfig;
