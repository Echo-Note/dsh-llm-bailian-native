#!/usr/bin/env node
/**
 * Extract one version's section from CHANGELOG.md, for the GitHub Release body.
 *
 * Follows the convention in `Echo-Note/gitea-toolkit`'s `scripts/release-notes.mjs`:
 * the release body is the CHANGELOG block itself, not `--generate-notes`. That way
 * the Release, the CHANGELOG file and any packaged copy say the same thing, and the
 * notes stay written for a human instead of being a commit list.
 *
 * Usage:
 *   node scripts/release-notes.mjs --version 0.7.4 --out release-notes.md
 *   node scripts/release-notes.mjs --version 0.7.4          # stdout
 *
 * Exits non-zero when the version has no section, so a release can never ship an
 * empty body.
 *
 * @module @local/dsh-llm-bailian-native/scripts/release-notes
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { version: undefined, out: undefined, changelog: join(ROOT, 'CHANGELOG.md') }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--version') args.version = argv[++index]
    else if (flag === '--out') args.out = argv[++index]
    else if (flag === '--changelog') args.changelog = argv[++index]
    else if (flag === '--help' || flag === '-h') args.help = true
  }
  return args
}

/**
 * Pull the body of one `## [x.y.z]` section.
 * @param {string} markdown
 * @param {string} version
 * @returns {string | undefined}
 */
export function sectionFor(markdown, version) {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => new RegExp(`^##\\s*\\[${version.replace(/\./g, '\\.')}\\]`).test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s/.test(lines[index])) {
      end = index
      break
    }
  }
  // Drop the heading line itself and the surrounding blank lines.
  return lines.slice(start + 1, end).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '')
}

const args = parseArgs(process.argv.slice(2))

if (args.help === true) {
  process.stdout.write('usage: release-notes.mjs --version <x.y.z> [--out <file>] [--changelog <file>]\n')
  process.exit(0)
}

if (typeof args.version !== 'string' || args.version.length === 0) {
  process.stderr.write('release-notes: --version is required\n')
  process.exit(2)
}

const markdown = readFileSync(args.changelog, 'utf8')
const section = sectionFor(markdown, args.version)

if (section === undefined || section.length === 0) {
  process.stderr.write(`release-notes: CHANGELOG.md has no non-empty section for ${args.version}\n`)
  process.exit(1)
}

if (args.out === undefined) process.stdout.write(`${section}\n`)
else {
  writeFileSync(args.out, `${section}\n`, 'utf8')
  process.stdout.write(`release-notes: wrote ${section.split('\n').length} lines to ${args.out}\n`)
}
