import { closePools } from '../client.js'
import { seedDemoOrganization } from '../seed/index.js'

try {
  const result = await seedDemoOrganization()
  console.log('Seeded the demo organization.\n')
  for (const [key, value] of Object.entries(result.counts)) {
    console.log(`  ${key.padEnd(16)} ${value}`)
  }
  console.log(`\n  organization     ${result.organizationId}`)
  console.log(`\nSign in as ${result.login.email} / ${result.login.password}`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
