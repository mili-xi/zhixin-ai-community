import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const apiBaseUrl = process.env.FASTAPI_BASE_URL || "http://127.0.0.1:8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Docker runtime uses the standalone output for a small production image.
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@zengxing/core"],
  async headers() {
    return [
      {
        source: "/downloads/desktop-version.json",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: "*"
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, OPTIONS"
          },
          {
            key: "Access-Control-Allow-Headers",
            value: "Content-Type"
          },
          {
            key: "Cache-Control",
            value: "no-store"
          }
        ]
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: "/mcp",
        destination: `${apiBaseUrl}/mcp`
      },
      {
        source: "/api/:path*",
        destination: `${apiBaseUrl}/api/:path*`
      },
      {
        source: "/health",
        destination: `${apiBaseUrl}/health`
      },
      {
        source: "/uploads/:path*",
        destination: `${apiBaseUrl}/uploads/:path*`
      }
    ];
  },
  async redirects() {
    const routes = [
      ["/serp-analysis", "/ai-writer/serp"],
      ["/knowledge-base", "/ai-writer/knowledge"],
      ["/assets", "/ai-writer/assets"],
      ["/generation-rules", "/ai-writer/rules"],
      ["/watermarks", "/ai-writer/watermarks"],
      ["/article-types", "/ai-writer/templates"],
      ["/creation-history", "/articles/history"],
      ["/analytics", "/published"],
      ["/brand-library", "/ai-writer/knowledge"],
      ["/competitor-library", "/ai-writer/knowledge"],
      ["/sites", "/published"],
      ["/media-market", "/published"],
      ["/publishes", "/published"],
      ["/llm-requests", "/articles/history"],
      ["/failure-center", "/dashboard"],
      ["/notifications", "/dashboard"],
      ["/keywords", "/dashboard"],
      ["/keyword-mining", "/dashboard"],
      ["/competitors", "/dashboard"],
      ["/geo-analysis", "/dashboard"],
      ["/geo-stats", "/dashboard"],
      ["/auto-geo", "/dashboard"],
      ["/seo-providers", "/dashboard"],
      ["/ranking-tracker", "/dashboard"],
      ["/seo-geo", "/dashboard"]
    ];

    return routes.map(([source, destination]) => ({ source, destination, permanent: true }));
  }
};

export default nextConfig;
