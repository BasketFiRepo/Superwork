import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Loads the repository .env before any test imports the config package, which fails
 * fast on missing variables by design.
 */
const path = fileURLToPath(new URL('../../.env', import.meta.url))

try {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    const [, key, value] = match
    if (key && process.env[key] === undefined) process.env[key] = value
  }
} catch {
  // CI provides the variables directly.
}

process.env['NODE_ENV'] = 'test'
