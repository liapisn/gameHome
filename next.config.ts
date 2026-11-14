import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

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

// Durable workflows (src/workflows): tour builds run on Vercel, started by the Generate button.
export default withWorkflow(nextConfig);
