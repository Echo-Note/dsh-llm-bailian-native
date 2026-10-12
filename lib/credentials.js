/**
 * Credential resolution through the harness credentials seam.
 *
 * A route names a reference (`apiKeyEnv`), never a value. Resolution order:
 *   1. `ctx.credentials.resolve(ref)` — the seam the Models page writes through;
 *   2. the launching environment (`process.env[ref]`), which is how a
 *      deployment that mounts no credential store still authenticates;
 *   3. nothing → `MISSING_CREDENTIAL`.
 *
 * A key that resolves but cannot ride an HTTP header fails as
 * `INVALID_CREDENTIAL` and names the reference to fix — never any part of the
 * key itself.
 *
 * @module @local/dsh-llm-bailian-native/credentials
 */

import { FAILURE_CODES, failure } from './protocol.js'

const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const PKG = '@local/dsh-llm-bailian-native'

/**
 * Judge one supplied key. Mirrors `@deepseek-ai/dsh-llm`'s `normalizeApiKey`
 * without importing it, so the wire layer keeps no DSH dependency.
 * @param {string} raw
 * @returns {{ ok: true, value: string } | { ok: false, reason: 'empty' | 'illegalCharacters' }}
 */
export function normalizeApiKey(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

/**
 * Resolve the credential a route references.
 *
 * @param {import('./protocol.js').ResolvedRoute} route
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<string | undefined>} the key, or `undefined` when the route
 *   names no reference at all (deployments may authenticate out of band)
 * @throws {Error & { code: string }} `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`
 */
export async function resolveApiKey(route, ctx) {
  const ref = route.apiKeyEnv
  if (ref === undefined || ref.length === 0) return undefined

  /** @type {string | undefined} */
  let raw
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) raw = hit.value
  }
  if (raw === undefined) {
    const fromEnvironment = ctx.get('launchEnvironment')?.get?.(ref)?.value
      ?? (typeof process !== 'undefined' ? process.env?.[ref] : undefined)
    if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) raw = fromEnvironment
  }

  if (raw === undefined) {
    throw failure(
      FAILURE_CODES.MISSING_CREDENTIAL,
      `${PKG}: no credential for provider route "${route.route}"; it references ${ref}, which is not set — `
      + `store ${ref} through the credentials seam (the Web Models page writes it) or export it in the launching environment`,
    )
  }

  const checked = normalizeApiKey(raw)
  if (!checked.ok) {
    throw failure(
      FAILURE_CODES.INVALID_CREDENTIAL,
      checked.reason === 'empty'
        ? `${PKG}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        : `${PKG}: the API key resolved from ${ref} contains characters no HTTP header can carry; set ${ref} to the raw key alone`,
    )
  }
  return checked.value
}

/**
 * Report credential state without reading the value, for the settings UI.
 * @param {import('./protocol.js').ResolvedRoute} route
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<{ ref?: string, configured: boolean, source?: string, writable?: boolean, reason?: string }>}
 */
export async function describeApiKey(route, ctx) {
  if (route === undefined || route === null) {
    return { configured: false, source: 'none', reason: 'this provider route is not configured, so it has no credential to resolve' }
  }
  const ref = route.apiKeyEnv
  if (ref === undefined || ref.length === 0) return { configured: false, reason: 'this route names no credential reference' }
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.describe === 'function') {
    try {
      const info = await credentials.describe(ref)
      if (info?.configured === true) {
        return {
          ref,
          configured: true,
          ...(typeof info.source === 'string' ? { source: info.source } : {}),
          ...(typeof info.writable === 'boolean' ? { writable: info.writable } : {}),
        }
      }
      // Fall through to the environment: describe() knows only the store.
    } catch (error) {
      return { ref, configured: false, source: 'none', reason: error instanceof Error ? error.message : String(error) }
    }
  }
  const fromEnvironment = process.env?.[ref]
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) {
    return { ref, configured: true, source: 'environment', writable: false }
  }
  return { ref, configured: false, source: 'none', reason: `${ref} is not set in the credential store or the launching environment` }
}
