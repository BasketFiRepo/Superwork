import { closePools } from '../client.js'
import { down, reset, up } from '../migrate.js'

const command = process.argv[2] ?? 'up'

try {
  if (command === 'up') {
    const run = await up(process.argv[3])
    console.log(run.length ? `Applied:\n${run.map((n) => `  ${n}`).join('\n')}` : 'Already up to date.')
  } else if (command === 'down') {
    const steps = Number(process.argv[3] ?? 1)
    const reverted = await down(steps)
    console.log(reverted.length ? `Reverted:\n${reverted.map((n) => `  ${n}`).join('\n')}` : 'Nothing to revert.')
  } else if (command === 'reset') {
    await reset()
    console.log('Schema reset and rebuilt.')
  } else {
    console.error(`Unknown command "${command}". Use: up | down [steps] | reset`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await closePools()
}
