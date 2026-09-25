import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pdf-parse', 'pdfkit', '@modelcontextprotocol/sdk', '@composio/core'],
};

export default nextConfig;
