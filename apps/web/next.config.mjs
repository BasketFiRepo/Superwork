import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The workspace keeps one `.env` at the repository root, and every script reads it with
 * `node --env-file=.env`. Next resolves its own env files relative to `apps/web`, so
 * without this a built server starts and then answers every request with "DATABASE_URL:
 * Required" — the app looks up and is not.
 *
 * Real environment variables always win, so a platform that injects its own configuration
 * is unaffected, and a missing file is not an error: that is the deployed case.
 */
function loadWorkspaceEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  let contents
  try {
    contents = readFileSync(join(root, '.env'), 'utf8')
  } catch {
    return
  }
  for (const line of contents.split('\n')) {
    if (line.trimStart().startsWith('#')) continue
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}

loadWorkspaceEnv()

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
