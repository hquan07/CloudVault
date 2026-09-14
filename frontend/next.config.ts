import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow external images (MinIO thumbnails, avatars)
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000" },
      { protocol: "http", hostname: "minio", port: "9000" },
    ],
  },

  // Hide the Next.js development indicator (N icon) by moving it away from the Storage widget
  devIndicators: {
    position: 'bottom-right',
  },

  // Required for optimal Docker builds
  output: 'standalone',

  // Proxy API requests to backend services during development
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [
      { source: "/api/v1/auth/:path*", destination: "http://localhost:8001/api/v1/auth/:path*" },
      { source: "/api/v1/files/:path*", destination: "http://localhost:8002/api/v1/files/:path*" },
      { source: "/api/v1/folders/:path*", destination: "http://localhost:8002/api/v1/folders/:path*" },
      { source: "/api/v1/metadata/:path*", destination: "http://localhost:8003/api/v1/metadata/:path*" },
      { source: "/api/v1/share/:path*", destination: "http://localhost:8003/api/v1/share/:path*" },
      { source: "/api/v1/search/:path*", destination: "http://localhost:8003/api/v1/search/:path*" },
      { source: "/api/v1/activity/:path*", destination: "http://localhost:8003/api/v1/activity/:path*" },
      { source: "/api/v1/analytics/:path*", destination: "http://localhost:8003/api/v1/analytics/:path*" },
    ];
  },
};

export default nextConfig;
