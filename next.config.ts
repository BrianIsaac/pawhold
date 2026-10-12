import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: true,
  experimental: {
    // An update's photo is up to 5 MiB (U4's MAX_PHOTO_BYTES); with the finding
    // and the form's framing the vet's update stays under 6 MB.
    serverActions: { bodySizeLimit: "6mb" },
  },
};

export default nextConfig;
