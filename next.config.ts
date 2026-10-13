import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  turbopack: {
    resolveAlias: {
      // The day's board (U8b): Bryntum's React wrapper imports the Scheduler's
      // core, which the browser loads itself; the bundler is given the few
      // names the wrapper needs instead (see the file).
      "@bryntum/scheduler": "./app/(practice)/day/scheduler-core.ts",
    },
  },
  experimental: {
    // An update's photo is up to 5 MiB (U4's MAX_PHOTO_BYTES); with the finding
    // and the form's framing the vet's update stays under 6 MB.
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
