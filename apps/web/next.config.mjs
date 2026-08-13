/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source and are compiled by Next.
  transpilePackages: [
    '@superwork/config',
    '@superwork/db',
    '@superwork/core',
    '@superwork/auth',
    '@superwork/ai',
    '@superwork/tools',
    '@superwork/agent',
    '@superwork/ui',
  ],
  serverExternalPackages: ['postgres'],
  experimental: {
    // The agent runtime continues after the response stream closes (§5.8).
    serverActions: { bodySizeLimit: '4mb' },
  },
  // Workspace packages are ESM TypeScript source and import each other with explicit
  // `.js` specifiers, as the TypeScript ESM spec requires. Teach the bundler to resolve
  // those back to the `.ts` files it is compiling.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ]
  },
}

export default nextConfig
