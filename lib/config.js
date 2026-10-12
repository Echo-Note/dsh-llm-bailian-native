/**
 * Configuration schema and route resolution.
 *
 * The config is a dictionary keyed by provider route, so several routes can be
 * active at once (`bailian-native` for a workspace-dedicated host, a second route
 * for the public shared host, and a future `tencent-native` route). `protocol` is
 * the discriminator that selects the wire adapter from the registry — which is
 * why adding a vendor later needs no change in this file.
 *
 * @module @local/dsh-llm-bailian-native/config
 */

import z from '../vendor/schemastery/lib/index.mjs'
import { bundledPrice, bundledTiers, CACHE_RULES, catalogFor, DEFAULT_ENABLED_MODELS, PRICE_TABLE } from './catalog.js'
import { protocolFor, registeredProtocols } from './providers/index.js'
import { FAILURE_CODES, REASONING_EFFORTS } from './protocol.js'

const MODALITY = ['text', 'image']

/** One model override entry in a route's catalog. */
const model = z.object({
  id: z.string().required().description('Provider model id, e.g. qwen3.8-max'),
  name: z.string().description('Display name (defaults to the id)'),
  contextWindow: z.natural().description('Context window (tokens)'),
  maxTokens: z.natural().description('Max output tokens'),
  inputModalities: z.array(z.union(MODALITY)).description('Accepted input types (empty = text only)'),
  thinkingBudgets: z.dict(z.natural()).description('thinking_budget per effort, e.g. { low: 1024, high: 8192 }'),
  snapshotOf: z.string().description('Alias grouping used to share a price row'),
})

/** One model's local billing rates, per 1,000,000 tokens. */
const price = z.object({
  cacheMiss: z.natural().default(0).description('Uncached input, per 1M tokens'),
  cacheHit: z.natural().description('Cache-hit input, per 1M tokens (empty = unpublished)'),
  output: z.natural().default(0).description('Output, per 1M tokens'),
  currency: z.string().default('CNY').description('Currency (CNY mainland / USD international)'),
  source: z.string().default('user').description('user | official | official-derived | bundled-unverified'),
  sourceUrl: z.string().description('Price source URL'),
  checkedAt: z.string().description('Price checked on (ISO date)'),
  verified: z.boolean().default(true).description('False marks the price as an unconfirmed estimate'),
  tiers: z.array(z.object({
    aboveInputTokens: z.natural().required().description('Tier applies above this input size'),
    cacheMiss: z.natural().default(0),
    cacheHit: z.natural(),
    output: z.natural().default(0),
  })).description('Input-token tiers; all tokens bill at the selected tier'),
})

/** One provider route. */
const profile = z.object({
  // Deliberately a plain string, not a union of the registered protocols: a
  // union would reject `tencent-native` here and then silently fall back to the
  // schema default, turning a clear "not implemented yet" into a route that
  // talks the wrong protocol. `resolveRoute()` validates it explicitly instead.
  protocol: z.string()
    .description(`Required. ${registeredProtocols().join(', ')} implemented; tencent-native / baidu-native reserved`),
  displayName: z.string().description('Name shown in the model list'),
  baseURL: z.string().description('Host or base URL; /compatible-mode/v1 is stripped automatically'),
  apiKeyEnv: z.string()
    .description('Required. Credential reference, e.g. DASHSCOPE_API_KEY — never the key itself'),
  headers: z.dict(z.string()).description('Extra request headers'),
  timeoutMs: z.natural().default(600000).description('Request deadline (ms)'),
  streamIdleTimeoutMs: z.natural().default(300000).description('Max silence between stream frames (ms)'),
  models: z.array(model).description('Model catalog; merges over the bundled one'),
  modelDisabled: z.array(z.string()).description('Model ids to hide from the picker'),
  defaultModel: z.string().description('Default model'),
  defaultContextWindow: z.natural().default(262144).description('Fallback context window (tokens)'),
  generationPath: z.union(['auto', 'text', 'multimodal']).default('auto')
    .description('Native sub-path; auto decides per model class'),
  generationPathOverrides: z.dict(z.union(['text', 'multimodal'])).description('Per-model sub-path overrides'),
  pricing: z.object({
    currency: z.string().default('CNY').description('Currency for this route'),
    models: z.dict(price).description('Per-model price overrides, per 1M tokens'),
  }).description('Local billing price table (per 1M tokens)'),
  catalog: z.object({
    cache: z.boolean().default(true).description('Reuse the last successful catalog when a refresh fails'),
    includeBundled: z.boolean().default(true).description('Merge the bundled catalog'),
    refreshMinutes: z.natural().default(0).description('Auto-refresh interval; 0 = manual only'),
  }).description('Catalog refresh'),
})

/** The plugin's Config. `providers` is a volatile dict so edits apply live. */
export const Config = z.object({
  providers: z.dict(profile).default({}).volatile(),
})

/**
 * A ready-to-use default profile, used by the UI's add-provider helper, by
 * `examples/` and by tests.
 * @param {string} [protocol]
 */
export function defaultProfile(protocol = 'dashscope-native') {
  const adapter = protocolFor(protocol)
  return {
    protocol,
    displayName: `${adapter.vendorDisplayName}（原生协议）`,
    baseURL: adapter.defaultBaseURLs[0],
    apiKeyEnv: adapter.defaultApiKeyEnvs[0],
    timeoutMs: 600000,
    streamIdleTimeoutMs: 300000,
    models: [],
    modelDisabled: [],
    defaultModel: DEFAULT_ENABLED_MODELS[0],
    defaultContextWindow: 262144,
    generationPath: 'auto',
    generationPathOverrides: {},
    pricing: { currency: 'CNY', models: {} },
    catalog: { cache: true, includeBundled: true, refreshMinutes: 0 },
  }
}

/**
 * Validate and normalize one configured route.
 *
 * Never returns a partially-usable route: a configuration defect throws and the
 * caller turns it into `LlmConfigurableProvider.error`, so the Models page shows
 * the diagnostic while unaffected routes keep serving.
 *
 * @param {string} route
 * @param {Record<string, unknown>} source
 * @returns {ResolvedRoute}
 */
export function resolveRoute(route, source) {
  if (typeof route !== 'string' || route.length === 0) throw configError('provider route names must be non-empty')
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw configError(`route "${route}" must be an object`)
  }
  const raw = /** @type {Record<string, any>} */ (source)

  const protocol = optionalString(raw.protocol) ?? 'dashscope-native'
  let adapter
  try {
    adapter = protocolFor(protocol)
  } catch (error) {
    throw configError(messageOf(error))
  }

  // A user may paste exactly the base URL their OpenAI-compatible route uses;
  // the adapter strips the known protocol suffixes so both routes can share one
  // configured string. Normalization lives in the adapter because it owns the
  // protocol's path grammar.
  const configuredBase = optionalString(raw.baseURL) ?? adapter.defaultBaseURLs[0]
  const baseURL = normalizeBaseURL(route, adapter.normalizeServiceRoot?.(configuredBase) ?? configuredBase)

  const overrides = Array.isArray(raw.models) ? raw.models.map((entry, index) => normalizeModel(route, entry, index)) : []
  const bundled = raw.catalog?.includeBundled === false ? [] : catalogFor(protocol)
  const models = mergeModels(bundled, overrides)
  if (models.length === 0) {
    throw configError(`route "${route}" has an empty model catalog; add models[] or leave catalog.includeBundled enabled`)
  }

  const modelDisabled = Array.isArray(raw.modelDisabled)
    ? raw.modelDisabled.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  const enabled = models.filter((entry) => !modelDisabled.includes(entry.id))
  if (enabled.length === 0) {
    throw configError(`route "${route}" disables every catalog model; the route would not be selectable`)
  }

  const pricing = raw.pricing ?? {}
  const generationPath = optionalString(raw.generationPath) ?? 'auto'
  if (!['auto', 'text', 'multimodal'].includes(generationPath)) {
    throw configError(`route "${route}" generationPath must be auto, text or multimodal`)
  }

  return {
    route,
    protocol,
    displayName: optionalString(raw.displayName) ?? adapter.vendorDisplayName,
    baseURL,
    apiKeyEnv: optionalString(raw.apiKeyEnv),
    headers: normalizeHeaders(route, raw.headers),
    timeoutMs: positive(raw.timeoutMs, 600000, `route "${route}" timeoutMs`),
    streamIdleTimeoutMs: positive(raw.streamIdleTimeoutMs, 300000, `route "${route}" streamIdleTimeoutMs`),
    models,
    modelDisabled,
    defaultModel: optionalString(raw.defaultModel) ?? enabled[0].id,
    defaultContextWindow: positive(raw.defaultContextWindow, 262144, `route "${route}" defaultContextWindow`),
    thinkingBudgets: {},
    generationPath,
    generationPathOverrides: normalizePathOverrides(route, raw.generationPathOverrides),
    priceCurrency: optionalString(pricing.currency) ?? 'CNY',
    priceOverrides: normalizePriceOverrides(route, pricing.models),
    cacheCatalog: raw.catalog?.cache !== false,
    catalogRefreshMinutes: Number(raw.catalog?.refreshMinutes) > 0 ? Number(raw.catalog.refreshMinutes) : 0,
    // The multimodal family list is adapter-owned policy, not user config.
    multimodalFamilies: adapter.multimodalModelPrefixes ?? ['qwen3.8', 'qwen3.7', 'qwen3.6', 'qwen3.5'],
  }
}

/**
 * Resolve every configured route, separating serviceable routes from ones whose
 * configuration is wrong.
 *
 * @param {Record<string, unknown> | undefined} providers
 * @returns {{ routes: Map<string, ResolvedRoute>, errors: Map<string, string> }}
 */
export function resolveRoutes(providers) {
  if (Array.isArray(providers)) {
    throw configError('providers is a dict keyed by provider route, not an array of profiles')
  }
  const routes = new Map()
  const errors = new Map()
  for (const [route, source] of Object.entries(providers ?? {})) {
    try {
      routes.set(route, resolveRoute(route, source))
    } catch (error) {
      errors.set(route, messageOf(error))
    }
  }
  return { routes, errors }
}

/**
 * Merge the bundled catalog with configured overrides. Configured entries win on
 * every field they declare; bundled-only models survive, so editing one model
 * does not silently drop the rest.
 * @param {ReadonlyArray<import('./catalog.js').CatalogEntry>} bundled
 * @param {Array<Record<string, unknown>>} overrides
 */
function mergeModels(bundled, overrides) {
  /** @type {Map<string, Record<string, any>>} */
  const merged = new Map()
  for (const entry of bundled) {
    merged.set(entry.id, {
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
      inputModalities: [...entry.inputModalities],
      ...(entry.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...entry.thinkingBudgets } }),
      source: entry.source,
    })
  }
  for (const override of overrides) {
    const existing = merged.get(override.id)
    merged.set(override.id, {
      ...existing,
      ...override,
      ...(override.thinkingBudgets === undefined && existing?.thinkingBudgets !== undefined
        ? { thinkingBudgets: existing.thinkingBudgets }
        : {}),
      source: override.source ?? existing?.source ?? 'configured',
    })
  }
  return [...merged.values()]
}

/** @param {string} route @param {unknown} entry @param {number} index */
function normalizeModel(route, entry, index) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw configError(`route "${route}" models[${index}] must be an object`)
  }
  const raw = /** @type {Record<string, any>} */ (entry)
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw configError(`route "${route}" models[${index}] needs a non-empty id`)
  }
  const inputModalities = Array.isArray(raw.inputModalities)
    ? raw.inputModalities.filter((value) => MODALITY.includes(value))
    : undefined
  const contextWindow = optionalPositive(raw.contextWindow)
  const maxTokens = optionalPositive(raw.maxTokens)
  return {
    id: raw.id,
    name: optionalString(raw.name) ?? raw.id,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(raw.thinkingBudgets === undefined || typeof raw.thinkingBudgets !== 'object'
      ? {}
      : { thinkingBudgets: normalizeBudgets(raw.thinkingBudgets) }),
    ...(optionalString(raw.snapshotOf) === undefined ? {} : { snapshotOf: optionalString(raw.snapshotOf) }),
    source: 'configured',
  }
}

/** @param {unknown} value */
function normalizeBudgets(value) {
  const result = {}
  for (const effort of REASONING_EFFORTS) {
    const budget = optionalPositive(/** @type {Record<string, unknown>} */ (value)[effort])
    if (budget !== undefined) result[effort] = budget
  }
  return result
}

/** @param {string} route @param {unknown} value */
function normalizePathOverrides(route, value) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw configError(`route "${route}" generationPathOverrides must be a dict keyed by model id`)
  }
  const result = {}
  for (const [id, path] of Object.entries(value)) {
    if (path !== 'text' && path !== 'multimodal') {
      throw configError(`route "${route}" generationPathOverrides["${id}"] must be text or multimodal`)
    }
    result[id] = path
  }
  return result
}

/** @param {string} route @param {unknown} models */
function normalizePriceOverrides(route, models) {
  if (models === undefined || models === null) return {}
  if (typeof models !== 'object' || Array.isArray(models)) {
    throw configError(`route "${route}" pricing.models must be a dict keyed by model id`)
  }
  const result = {}
  for (const [id, value] of Object.entries(models)) {
    if (value === null || typeof value !== 'object') throw configError(`route "${route}" pricing.models["${id}"] must be an object`)
    const raw = /** @type {Record<string, any>} */ (value)
    const tiers = Array.isArray(raw.tiers)
      ? raw.tiers
        .map((tier) => {
          const above = optionalPositive(tier?.aboveInputTokens)
          if (above === undefined) return undefined
          return {
            aboveInputTokens: above,
            cacheMiss: nonNegative(tier.cacheMiss, 0),
            cacheHit: optionalNonNegative(tier.cacheHit),
            output: nonNegative(tier.output, 0),
          }
        })
        .filter((tier) => tier !== undefined)
        .sort((left, right) => left.aboveInputTokens - right.aboveInputTokens)
      : undefined
    result[id] = {
      cacheMiss: nonNegative(raw.cacheMiss, 0),
      cacheHit: optionalNonNegative(raw.cacheHit),
      output: nonNegative(raw.output, 0),
      currency: optionalString(raw.currency) ?? 'CNY',
      source: optionalString(raw.source) ?? 'user',
      verified: raw.verified !== false,
      ...(optionalString(raw.sourceUrl) === undefined ? {} : { sourceUrl: optionalString(raw.sourceUrl) }),
      ...(optionalString(raw.checkedAt) === undefined ? {} : { checkedAt: optionalString(raw.checkedAt) }),
      ...(tiers === undefined || tiers.length === 0 ? {} : { tiers }),
    }
  }
  return result
}

/**
 * Resolve the price row local billing uses for one exact model.
 *
 * Precedence: configured override → bundled table (following the alias chain) →
 * nothing. "Nothing" is reported as `source: 'none'`, `verified: false`, and the
 * ledger marks the call unpriced rather than implying a price it does not have.
 *
 * `cacheHit: null` is preserved as **unknown**, never coerced to 0: for
 * `qwen3.8-max`/`qwen3.8-flash` the provider explicitly excludes cache reads
 * from its published rule and defers to the console.
 *
 * @param {ResolvedRoute} route
 * @param {string} model
 * @param {{ snapshotOf?: string }} [hints]
 * @returns {ResolvedPrice}
 */
export function priceFor(route, model, hints) {
  const override = route.priceOverrides[model]
  if (override !== undefined) {
    return {
      cacheMiss: override.cacheMiss,
      cacheHit: override.cacheHit,
      output: override.output,
      currency: String(override.currency ?? route.priceCurrency),
      source: String(override.source ?? 'user'),
      verified: override.verified !== false,
      ...(override.tiers === undefined ? {} : { tiers: override.tiers }),
      ...(override.sourceUrl === undefined ? {} : { sourceUrl: override.sourceUrl }),
    }
  }

  const bundled = bundledPrice(model, hints)
  if (bundled !== undefined) {
    const tiers = bundledTiers(model, hints)
    return {
      cacheMiss: bundled.cacheMiss,
      // Derive only when the provider's published rule actually covers the
      // model; its documented exceptions stay unknown.
      cacheHit: bundled.cacheHit ?? deriveCacheHit(model, bundled.cacheMiss, hints),
      output: bundled.output,
      currency: bundled.currency,
      source: bundled.cacheHit === null && !isCacheException(model, hints) ? 'official-derived' : bundled.source,
      verified: bundled.verified,
      ...(tiers === undefined ? {} : { tiers: tiers.map((tier) => ({ ...tier })) }),
      ...(bundled.sourceUrl === undefined ? {} : { sourceUrl: bundled.sourceUrl }),
    }
  }

  return { cacheMiss: 0, cacheHit: null, output: 0, currency: route.priceCurrency, source: 'none', verified: false }
}

/** @param {string} model @param {{ snapshotOf?: string }} [hints] */
function isCacheException(model, hints) {
  const key = hints?.snapshotOf ?? model
  return CACHE_RULES.exceptions.some((entry) => key === entry || key.startsWith(`${entry}-`))
}

/**
 * Apply the published cache rule to a model without an absolute cache price.
 * Prefers the implicit rule (20 %), which is the one that applies unless the
 * caller sends an explicit `cache_control` marker.
 * @param {string} model
 * @param {number} cacheMiss
 * @param {{ snapshotOf?: string }} [hints]
 * @returns {number | null}
 */
function deriveCacheHit(model, cacheMiss, hints) {
  if (isCacheException(model, hints)) return null
  return Math.round(cacheMiss * CACHE_RULES.implicitHitRatio * 1e6) / 1e6
}

/**
 * Compute a local cost estimate from harness usage buckets.
 *
 * Mirrors the `dsh-cost-meter` convention so the two agree by construction:
 *   cost = (input·cacheMiss + output·output + cacheRead·cacheHit
 *           + cacheWrite·cacheHit) / 1e6
 * Reasoning tokens are already inside `outputTokens` in the harness vocabulary,
 * so they are not billed twice.
 *
 * Tier selection follows the published rule exactly: the tier is chosen by the
 * request's **total input** tokens and then applies to **all** tokens — it is not
 * a progressive scale.
 *
 * @param {{ inputTokens: number, outputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }} usage
 * @param {ResolvedPrice} price
 * @returns {{ cost: number, currency: string, approximate: boolean, tier: number | null, note?: string }}
 */
export function computeCost(usage, price) {
  // `inputTokens` is the request's **total** prompt size; the harness reports the
  // cached portion of it separately in `cacheReadTokens`. Billing both the total
  // at the uncached rate *and* the cached slice at the cached rate would count the
  // cached tokens twice and make a cache hit look more expensive than a miss
  // (measured: +16.6 % on a real 1024-of-1231 hit). The uncached remainder is
  // therefore what the uncached rate applies to.
  const totalInput = Math.max(0, Number(usage.inputTokens) || 0)
  const cacheRead = Math.min(Math.max(0, Number(usage.cacheReadTokens) || 0), totalInput)
  const cacheWrite = Math.max(0, Number(usage.cacheWriteTokens) || 0)
  const input = Math.max(0, totalInput - cacheRead)
  const output = Math.max(0, Number(usage.outputTokens) || 0)

  let rate = price
  let tier = null
  if (Array.isArray(price.tiers)) {
    for (const candidate of price.tiers) {
      if (totalInput > candidate.aboveInputTokens) {
        rate = { ...price, ...candidate }
        tier = candidate.aboveInputTokens
      }
    }
  }

  // A prompt-cache hit is the main lever on this provider's bill: the gateway
  // reports `cacheReadTokens`, and those tokens are charged at a fraction of the
  // uncached rate. When the provider does not publish that fraction for an exact
  // model (its documented exceptions are `qwen3.8-max` / `qwen3.8-flash`), the
  // published *implicit* rule (20 % of the input price) is used as a conservative
  // estimate — billing cached tokens at the full uncached rate would answer 0 %
  // saved on a request that really is discounted, which is worse than an estimate
  // that is labelled as one.
  const published = rate.cacheHit
  const derived = published === null || published === undefined
  const cacheHitRate = derived ? deriveCacheHitRate(rate.cacheMiss) : published
  const cachedTokens = cacheRead + cacheWrite
  const cacheCost = cachedTokens * cacheHitRate

  const cost = (input * rate.cacheMiss + output * rate.output + cacheCost) / 1e6
  const approximate = derived || price.verified === false
  // What the cache saved on this request: the cached slice at the uncached rate,
  // minus what it was actually charged.
  const cacheSavings = cachedTokens > 0 ? (cachedTokens * (rate.cacheMiss - cacheHitRate)) / 1e6 : 0
  return {
    cost,
    currency: price.currency,
    approximate,
    tier,
    cacheHitRate,
    cacheHitDerived: derived,
    cacheSavings,
    ...(derived
      ? {
          note: `the provider does not publish a cache-read price for this model, so cached tokens are estimated with the published implicit-cache rule (${Math.round(CACHE_RULES.implicitHitRatio * 100)}% of the input price): ${CACHE_RULES.sourceUrl}`,
        }
      : price.verified === false
        ? { note: 'this price row is an unconfirmed bundled estimate' }
        : {}),
  }
}

/**
 * The published implicit-cache rule, as a rate per 1M tokens.
 * @param {number} cacheMiss
 * @returns {number}
 */
function deriveCacheHitRate(cacheMiss) {
  return Math.round(Math.max(0, Number(cacheMiss) || 0) * CACHE_RULES.implicitHitRatio * 1e6) / 1e6
}

/** Every bundled price row plus its source, for the settings UI's price view. */
export function bundledPriceRows() {
  return Object.entries(PRICE_TABLE).map(([model, row]) => ({ model, ...row }))
}

/** @param {string} message */
function configError(message) {
  const error = new Error(message)
  error.code = FAILURE_CODES.INVALID_CONFIG
  return error
}

/** @param {string} route @param {unknown} value */
function normalizeBaseURL(route, value) {
  if (typeof value !== 'string' || value.length === 0) throw configError(`route "${route}" has an empty baseURL`)
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw configError(`route "${route}" baseURL is not a valid URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw configError(`route "${route}" baseURL must use http or https`)
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw configError(`route "${route}" baseURL must not embed credentials`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw configError(`route "${route}" baseURL must not carry a query or fragment`)
  }
  return value.replace(/\/+$/, '')
}

/** @param {string} route @param {unknown} headers */
function normalizeHeaders(route, headers) {
  if (headers === undefined || headers === null) return {}
  if (typeof headers !== 'object' || Array.isArray(headers)) throw configError(`route "${route}" headers must be a dict`)
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') throw configError(`route "${route}" header "${name}" must be a string`)
    try {
      new Headers([[name, value]])
    } catch {
      throw configError(`route "${route}" header "${name}" cannot be represented on the wire`)
    }
    result[name] = value
  }
  return result
}

/** @param {unknown} value */
function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** @param {unknown} value @param {number} fallback @param {string} label */
function positive(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw configError(`${label} must be a positive number`)
  return n
}

/** @param {unknown} value */
function optionalPositive(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

/** @param {unknown} value @param {number} fallback */
function nonNegative(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** @param {unknown} value @returns {number | null} */
function optionalNonNegative(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * @typedef {object} ResolvedPrice
 * @property {number} cacheMiss
 * @property {number | null} cacheHit
 * @property {number} output
 * @property {string} currency
 * @property {string} source
 * @property {boolean} verified
 * @property {Array<{ aboveInputTokens: number, cacheMiss: number, cacheHit: number | null, output: number }>} [tiers]
 * @property {string} [sourceUrl]
 */

/**
 * @typedef {object} ResolvedRoute
 * @property {string} route
 * @property {string} protocol
 * @property {string} displayName
 * @property {string} baseURL
 * @property {string | undefined} apiKeyEnv
 * @property {Record<string, string>} headers
 * @property {number} timeoutMs
 * @property {number} streamIdleTimeoutMs
 * @property {ReadonlyArray<Record<string, any>>} models
 * @property {string[]} modelDisabled
 * @property {string} defaultModel
 * @property {number} defaultContextWindow
 * @property {Record<string, number>} thinkingBudgets
 * @property {string} generationPath
 * @property {Record<string, 'text' | 'multimodal'>} generationPathOverrides
 * @property {string} priceCurrency
 * @property {Record<string, Record<string, any>>} priceOverrides
 * @property {boolean} cacheCatalog
 * @property {number} catalogRefreshMinutes
 * @property {string[]} multimodalFamilies
 */
