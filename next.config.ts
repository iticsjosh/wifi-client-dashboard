import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Trim React dev artefacts from production bundles.
  reactStrictMode: true,
  // Helps OpenNext / Wrangler bundle resolve the project root unambiguously.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
