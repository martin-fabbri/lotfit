import type { NextConfig } from "next";
import { join } from "node:path";

// The app reads the repo's own records (cases, runs, the Rulebook graph) from outside web/, so the
// file tracing root is the repo and those files are traced into every server function.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: join(import.meta.dirname, ".."),
  outputFileTracingIncludes: {
    "/**": [
      "../graph/out/graph-or.json",
      "../query/cases/*.json",
      "../query/viewer/demo/**/*",
      "../query/player/index.html",
      "../query/player/scene.js",
      "../query/player/summary.js",
    ],
  },
  turbopack: { root: join(import.meta.dirname, "..") },
};

export default nextConfig;
