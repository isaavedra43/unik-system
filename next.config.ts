import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['pdf-parse', 'pdfkit', '@modelcontextprotocol/sdk'],
};

export default nextConfig;
