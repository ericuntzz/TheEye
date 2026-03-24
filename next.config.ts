import type { NextConfig } from "next";

const devPort = (process.env.PORT ?? "3000").replace(/[^0-9A-Za-z_-]/g, "") || "3000";

const sharpPackageVariants = [
  "@img/sharp-darwin-arm64",
  "@img/sharp-darwin-x64",
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-libvips-linux-arm",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-libvips-linux-ppc64",
  "@img/sharp-libvips-linux-riscv64",
  "@img/sharp-libvips-linux-s390x",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-libvips-linuxmusl-arm64",
  "@img/sharp-libvips-linuxmusl-x64",
  "@img/sharp-linux-arm",
  "@img/sharp-linux-arm64",
  "@img/sharp-linux-ppc64",
  "@img/sharp-linux-riscv64",
  "@img/sharp-linux-s390x",
  "@img/sharp-linux-x64",
  "@img/sharp-linuxmusl-arm64",
  "@img/sharp-linuxmusl-x64",
  "@img/sharp-wasm32",
  "@img/sharp-win32-arm64",
  "@img/sharp-win32-ia32",
  "@img/sharp-win32-x64",
] as const;

const onnxRuntimeTargets = [
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "win32", arch: "arm64" },
  { platform: "win32", arch: "x64" },
] as const;

function hasGlibcRuntime(): boolean {
  const report = process.report?.getReport?.() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;

  return Boolean(report?.header?.glibcVersionRuntime);
}

const isLinuxMusl =
  process.platform === "linux" &&
  !hasGlibcRuntime();

function getCurrentSharpPackages(): string[] {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return ["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"];
    }
    if (process.arch === "x64") {
      return ["@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"];
    }
    return [];
  }

  if (process.platform === "linux") {
    const sharpPrefix = isLinuxMusl ? "@img/sharp-linuxmusl" : "@img/sharp-linux";
    const libvipsPrefix = isLinuxMusl
      ? "@img/sharp-libvips-linuxmusl"
      : "@img/sharp-libvips-linux";

    if (process.arch === "arm") {
      return [`${libvipsPrefix}-arm`, `${sharpPrefix}-arm`];
    }

    if (["arm64", "ppc64", "riscv64", "s390x", "x64"].includes(process.arch)) {
      return [`${libvipsPrefix}-${process.arch}`, `${sharpPrefix}-${process.arch}`];
    }

    return [];
  }

  if (process.platform === "win32") {
    if (["arm64", "ia32", "x64"].includes(process.arch)) {
      return [`@img/sharp-win32-${process.arch}`];
    }
    return [];
  }

  return [];
}

const currentSharpPackages = getCurrentSharpPackages();
const sharpTraceIncludes = [
  "./node_modules/sharp/lib/**/*",
  "./node_modules/sharp/package.json",
  ...currentSharpPackages.map((pkg) => `./node_modules/${pkg}/**/*`),
];
const sharpTraceExcludes = [
  "./node_modules/sharp/install/**/*",
  "./node_modules/sharp/src/**/*",
  "./node_modules/sharp/**/*.d.ts",
  "./node_modules/sharp/README.md",
  "./node_modules/sharp/LICENSE",
  ...sharpPackageVariants
    .filter((pkg) => !currentSharpPackages.includes(pkg))
    .map((pkg) => `./node_modules/${pkg}/**/*`),
];

const currentOnnxRuntimePattern = `./node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/**/*`;
const onnxTraceIncludes = [
  "./node_modules/onnxruntime-common/dist/cjs/**/*",
  "./node_modules/onnxruntime-common/package.json",
  "./node_modules/onnxruntime-node/dist/**/*.js",
  "./node_modules/onnxruntime-node/package.json",
  currentOnnxRuntimePattern,
];
const onnxTraceExcludes = [
  "./node_modules/onnxruntime-common/dist/esm/**/*",
  "./node_modules/onnxruntime-common/lib/**/*",
  "./node_modules/onnxruntime-common/**/*.d.ts",
  "./node_modules/onnxruntime-common/**/*.map",
  "./node_modules/onnxruntime-common/README.md",
  "./node_modules/onnxruntime-node/dist/**/*.d.ts",
  "./node_modules/onnxruntime-node/dist/**/*.map",
  "./node_modules/onnxruntime-node/README.md",
  ...onnxRuntimeTargets
    .filter(
      (target) =>
        target.platform !== process.platform || target.arch !== process.arch,
    )
    .map(
      (target) =>
        `./node_modules/onnxruntime-node/bin/napi-v6/${target.platform}/${target.arch}/**/*`,
    ),
];

const sharpOnlyRoutes = [
  "/api/inspections/\\[id\\]",
  "/api/vision/compare",
];
const nativeVisionRoutes = [
  "/api/embeddings",
  "/api/properties/\\[id\\]/train",
  "/api/vision/compare-stream",
];

function buildTraceRouteMap(routes: string[], patterns: string[]) {
  return Object.fromEntries(routes.map((route) => [route, patterns]));
}

const nextConfig: NextConfig = {
  distDir:
    process.env.NODE_ENV === "production" ? ".next" : `.next-dev-${devPort}`,
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
  outputFileTracingIncludes: {
    ...buildTraceRouteMap(sharpOnlyRoutes, sharpTraceIncludes),
    ...buildTraceRouteMap(nativeVisionRoutes, [
      ...sharpTraceIncludes,
      ...onnxTraceIncludes,
    ]),
  },
  outputFileTracingExcludes: {
    ...buildTraceRouteMap(
      [...sharpOnlyRoutes, ...nativeVisionRoutes],
      sharpTraceExcludes,
    ),
    ...buildTraceRouteMap(nativeVisionRoutes, [
      ...sharpTraceExcludes,
      ...onnxTraceExcludes,
    ]),
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // Dev-server file cache has been unstable in this repo and can leave
      // Next unable to read routes-manifest/chunk artifacts after a few requests.
      config.cache = false;
    }
    return config;
  },
};

export default nextConfig;
