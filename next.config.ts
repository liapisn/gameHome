import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Tour data is read from disk at runtime; fixture photos only for tours a preview opts in
  // (INTERNAL_FIXTURE_TOURS) — the media route refuses everything else.
  outputFileTracingIncludes: {
    "/tour/[id]": ["./src/data/**/*.json"],
    "/api/tour-media/[tour]/[...path]": ["./src/data/tours/*.json", "./fixtures/listing-8218/photos/*"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
