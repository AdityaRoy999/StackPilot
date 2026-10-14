import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(__dirname),
  turbopack: {},
  // Avoid recompiling recently visited dashboard pages during development.
  onDemandEntries: {
    maxInactiveAge: 10 * 60 * 1000,
    pagesBufferLength: 16,
  },
  allowedDevOrigins: [
    "localhost:3000",
    "127.0.0.1:3000",
    "localhost",
    "127.0.0.1",
  ],
  experimental: { proxyTimeout: 300000 },
  async rewrites() {
    const backend = process.env.STACKPILOT_BACKEND_INTERNAL_URL || "http://127.0.0.1:8090";
    const agent = process.env.STACKPILOT_AI_INTERNAL_URL || "http://127.0.0.1:8010";
    const desktop = process.env.STACKPILOT_RDP_INTERNAL_URL || "http://127.0.0.1:8095";
    return [
      { source: "/api/v1/rdp/:path*", destination: `${desktop}/api/v1/rdp/:path*` },
      { source: "/ws/rdp", destination: `${desktop}/ws/rdp` },
      { source: "/api/v1/:path*", destination: `${backend}/api/v1/:path*` },
      { source: "/ws/browser/:path*", destination: `${agent}/ws/browser/:path*` },
      { source: "/ws/:path*", destination: `${backend}/ws/:path*` },
    ];
  },
  async redirects() {
    return [
      {
        source: "/login",
        destination: "/auth/login",
        permanent: false,
      },
      {
        source: "/register",
        destination: "/auth/register",
        permanent: false,
      },
      {
        source: "/forgot-password",
        destination: "/auth/forgot-password",
        permanent: false,
      },
    ];
  },
  async headers() {
    const isProduction = process.env.NODE_ENV === "production";
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          ...(isProduction
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
