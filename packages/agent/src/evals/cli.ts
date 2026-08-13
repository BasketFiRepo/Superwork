import { closePools } from '@superwork/db'
import { ALL_FIXTURES } from './fixtures.js'
import { demoSession, runSuite } from './harness.js'

const packFilter = process.argv[2]
const fixtures = packFilter ? ALL_FIXTURES.filter((f) => f.pack === packFilter) : ALL_FIXTURES

try {
  const session = await demoSession()
  const summary = await runSuite(session, fixtures)

  for (const result of summary.results) {
    console.log(`${result.passed ? '✓' : '✗'} [${result.pack}] ${result.id}  ${result.durationMs}ms  ${result.costCents.toFixed(4)}c`)
    for (const failure of result.failures) console.log(`    ${failure}`)
  }

  console.log('\nBy pack:')
  for (const [pack, stats] of Object.entries(summary.byPack)) {
    const required = pack === 'adversarial' ? ' (must be 100%)' : ''
    console.log(`  ${pack.padEnd(12)} ${stats.passed}/${stats.total}${required}`)
  }
  console.log(`\n${summary.passed}/${summary.total} fixtures passed · ${summary.totalCostCents.toFixed(4)} cents total`)

  const adversarial = summary.byPack['adversarial']
  if (adversarial && adversarial.passed < adversarial.total) {
    console.error('\nThe adversarial pack must pass at 100%. Failing the run.')
    process.exitCode = 1
  } else if (summary.passed < summary.total) {
    process.exitCode = 1
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
