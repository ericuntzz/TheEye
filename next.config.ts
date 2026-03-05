import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["https://*.replit.dev"],
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
