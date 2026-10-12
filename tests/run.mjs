/**
 * Run every offline suite in one process, and report a single exit code.
 *
 * Nothing here needs the network, DSH, or a credential: the live suites
 * (`tests/live-native.test.mjs`) are run deliberately, by hand, with a key in
 * the environment.
 *
 * Usage: `npm test`   or   `node tests/run.mjs`
 *
 * @module @local/dsh-llm-bailian-native/tests/run
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  'native-stream.test.mjs',
  'models-page-contract.test.mjs',
  'billing.test.mjs',
  'overview.test.mjs',
]

let failed = 0
for (const suite of suites) {
  process.stdout.write(`\n=== ${suite} ===\n`)
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

process.stdout.write(`\n${suites.length - failed}/${suites.length} suites passed\n`)
process.exit(failed === 0 ? 0 : 1)
