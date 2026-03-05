import type { NextConfig } from "next";

const devDomain = process.env.REPLIT_DEV_DOMAIN;
const allowedOrigins: string[] = [];
if (devDomain) {
  allowedOrigins.push(devDomain);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: allowedOrigins,
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
