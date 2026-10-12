/**
 * The statistics the settings page shows.
 *
 * This module exists because the page must show **numbers**, not documentation:
 *
 *   - real billed spend, per month and per `BASE_MODEL`, from the ModelStudio
 *     billing API (`lib/billing.js`);
 *   - the prompt-cache picture that decides most of the bill, computed with the
 *     corrected accounting in `lib/config.js`;
 *   - the local price table with its provenance, so a number can be traced.
 *
 * Credentials are addressed by reference only. The AccessKey pair falls back to
 * the conventional names so a deployment that already stores them needs no extra
 * configuration:
 *
 *   ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET
 *
 * @module @local/dsh-llm-bailian-native/stats
 */

import { getBillingOverview, getBillingTrend } from './billing.js'
import { CATALOG_PROVENANCE, CACHE_RULES } from './catalog.js'
import { computeCost, priceFor } from './config.js'

/** Conventional credential references, used when the route names none. */
export const DEFAULT_ACCESS_KEY_ID_REF = 'ALIYUN_ACCESS_KEY_ID'
export const DEFAULT_ACCESS_KEY_SECRET_REF = 'ALIYUN_ACCESS_KEY_SECRET'

/**
 * Resolve one credential through the harness seam, falling back to the
 * environment. Mirrors `lib/credentials.js` for a non-route reference.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} ref
 * @returns {Promise<string | undefined>}
 */
async function resolveRef(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
  }
  const fromEnv = process.env?.[ref]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined
}

/**
 * Which credential references the billing API will use, and whether they exist.
 * Never returns a value.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ accessKeyIdRef?: string, accessKeySecretRef?: string }} [refs]
 */
export async function billingCredentialState(ctx, refs = {}) {
  const idRef = refs.accessKeyIdRef ?? DEFAULT_ACCESS_KEY_ID_REF
  const secretRef = refs.accessKeySecretRef ?? DEFAULT_ACCESS_KEY_SECRET_REF
  const [id, secret] = await Promise.all([resolveRef(ctx, idRef), resolveRef(ctx, secretRef)])
  return {
    idRef,
    secretRef,
    idConfigured: id !== undefined,
    secretConfigured: secret !== undefined,
    // Reported so a mismatch between two halves of one key is visible without
    // ever revealing either.
    idSuffix: id === undefined ? null : id.slice(-4),
  }
}

/**
 * Query both billing operations for one month.
 *
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {string} input.billMonth            YYYY-MM
 * @param {string} [input.groupBy]            dimension, default BASE_MODEL
 * @param {number} [input.topNum]
 * @param {AbortSignal} [input.signal]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function billingReport({ ctx, billMonth, groupBy = 'BASE_MODEL', topNum = 10, signal }) {
  const state = await billingCredentialState(ctx)
  if (!state.idConfigured || !state.secretConfigured) {
    return {
      available: false,
      month: billMonth,
      credentials: state,
      reason: `billing needs an AccessKey pair; store ${state.idRef} and ${state.secretRef} through the credentials seam (only the reference names live in configuration)`,
    }
  }
  const accessKeyId = await resolveRef(ctx, state.idRef)
  const accessKeySecret = await resolveRef(ctx, state.secretRef)
  const credentials = { accessKeyId, accessKeySecret, regionId: 'cn-beijing', ...(signal === undefined ? {} : { signal }) }

  const overview = await getBillingOverview({ credentials, billMonth, groupBy, topNum })
  if (overview.ok === false) {
    return { available: false, month: billMonth, credentials: state, reason: `${overview.code}: ${overview.message}` }
  }

  // The trend gives the day-by-day shape; a failure there must not hide the total.
  const [year, month] = billMonth.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const trend = await getBillingTrend({
    credentials,
    granularity: 'DAY',
    start: `${billMonth}-01`,
    end: `${billMonth}-${String(lastDay).padStart(2, '0')}`,
    groupBy,
    topNum,
  })

  return {
    available: true,
    month: billMonth,
    groupBy,
    credentials: state,
    currency: overview.currency,
    totalAmount: overview.totalAmount,
    pretaxAmount: overview.pretaxAmount,
    taxAmount: overview.taxAmount,
    groups: overview.groups,
    requestId: overview.requestId ?? null,
    daily: trend.ok === false
      ? null
      : trend.resultByTime.map((bucket) => ({
          period: bucket.period,
          amount: bucket.total.amount,
          currency: bucket.total.currency,
          top: bucket.periodDetails.slice(0, 5).map((detail) => ({ key: detail.key, amount: detail.amount, percentage: detail.percentage })),
        })),
    trendError: trend.ok === false ? `${trend.code}: ${trend.message}` : null,
  }
}

/**
 * What a prompt-cache hit saves on one model, at a concrete prompt size.
 *
 * The arithmetic is the corrected one: `inputTokens` is the whole prompt, so the
 * uncached remainder is `prompt − cached`; billing both the whole prompt and the
 * cached slice would double-count it (measured: a hit then looks 16.6 % *dearer*
 * than a miss).
 *
 * @param {import('./config.js').ResolvedRoute} route
 * @param {string} model
 * @param {{ promptTokens?: number, cachedTokens?: number, outputTokens?: number }} [sample]
 */
export function cacheReport(route, model, sample = {}) {
  const promptTokens = sample.promptTokens ?? 1231
  const cachedTokens = Math.min(sample.cachedTokens ?? 1024, promptTokens)
  const outputTokens = sample.outputTokens ?? 1
  const entry = route.models.find((candidate) => candidate.id === model)
  const price = priceFor(route, model, entry?.snapshotOf === undefined ? undefined : { snapshotOf: entry.snapshotOf })
  const cold = computeCost({ inputTokens: promptTokens, outputTokens }, price)
  const warm = computeCost({ inputTokens: promptTokens, outputTokens, cacheReadTokens: cachedTokens }, price)
  return {
    model,
    promptTokens,
    cachedTokens,
    cacheHitShare: promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 1000) / 1000 : 0,
    currency: price.currency,
    uncachedInputRate: price.cacheMiss,
    cacheHitRate: price.cacheHit,
    cacheHitPublished: price.cacheHit !== null,
    coldCost: cold.cost,
    warmCost: warm.cost,
    savedAmount: warm.cacheSavings,
    savedPercent: cold.cost > 0 ? Math.round((1 - warm.cost / cold.cost) * 1000) / 10 : 0,
    approximate: warm.approximate,
    note: warm.note ?? null,
    rules: {
      implicitHitRatio: CACHE_RULES.implicitHitRatio,
      explicitHitRatio: CACHE_RULES.explicitHitRatio,
      explicitWriteRatio: CACHE_RULES.explicitWriteRatio,
      exceptions: [...CACHE_RULES.exceptions],
      sourceUrl: CACHE_RULES.sourceUrl,
    },
  }
}

/**
 * The local price table, one row per catalog model, with the price provenance
 * carried through so a rendered number can be traced to its source.
 * @param {import('./config.js').ResolvedRoute} route
 */
export function priceRows(route) {
  return route.models.map((entry) => {
    const price = priceFor(route, entry.id, entry.snapshotOf === undefined ? undefined : { snapshotOf: entry.snapshotOf })
    return {
      model: entry.id,
      enabled: !route.modelDisabled.includes(entry.id),
      currency: price.currency,
      cacheMiss: price.cacheMiss,
      cacheHit: price.cacheHit,
      cacheHitPublished: price.cacheHit !== null,
      output: price.output,
      source: price.source,
      verified: price.verified,
      sourceUrl: price.sourceUrl ?? null,
      tiers: price.tiers ?? [],
    }
  })
}

/**
 * Everything the page renders, in one payload.
 *
 * @param {object} input
 * @param {import('@deepseek-ai/cordis').Context} input.ctx
 * @param {import('./config.js').ResolvedRoute} input.route
 * @param {string} [input.billMonth]  defaults to the current month in local time
 * @param {string} [input.model]      model for the cache sample; defaults to the route default
 * @param {boolean} [input.includeBilling]
 * @param {AbortSignal} [input.signal]
 */
export async function buildStats({ ctx, route, billMonth, model, includeBilling = true, signal }) {
  const now = new Date()
  const month = billMonth ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const sampleModel = model ?? route.defaultModel ?? route.models[0]?.id
  return {
    route: route.route,
    displayName: route.displayName,
    baseURL: route.baseURL,
    apiKeyEnv: route.apiKeyEnv ?? null,
    month,
    billing: includeBilling
      ? await billingReport({ ctx, billMonth: month, topNum: 10, ...(signal === undefined ? {} : { signal }) })
      : { available: false, reason: 'billing not requested' },
    cache: cacheReport(route, sampleModel),
    prices: priceRows(route),
    catalog: {
      modelCount: route.models.length,
      enabledCount: route.models.length - route.modelDisabled.length,
      disabled: [...route.modelDisabled],
      provenance: CATALOG_PROVENANCE,
    },
  }
}

/**
 * The service the settings page calls through the gateway.
 *
 * The gateway resolves `service: 'bailianNative'` from the plugin context, so the
 * object registered here is what the page reaches as `remote.bailianNative`.
 * Deterministic, JSON-shaped returns only — no functions, no `undefined` leaves.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {() => Map<string, any>} routes
 */
export function createStatsService(ctx, routes) {
  /** The route this deployment is looking at. */
  const pick = () => {
    const map = routes()
    if (map.has('bailian-native')) return 'bailian-native'
    return [...map.keys()][0] ?? 'bailian-native'
  }

  const currentMonth = () => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  }

  return {
    /**
     * Everything the page shows, in one call.
     *
     * Deliberately **zero-parameter**: the harness convention for a
     * package-private invocation is that a method with no arguments carries no
     * codecs at all (the same shape `dsh-cost-meter`'s `fetchPrices` uses), and
     * the host already knows which route it serves.
     */
    async snapshot() {
      const route = pick()
      const resolved = routes().get(route)
      const credentials = await billingCredentialState(ctx)
      if (resolved === undefined) {
        return {
          route,
          configured: false,
          credentials,
          billing: { available: false, month: currentMonth(), credentials, reason: `provider route "${route}" is not configured; add it on the Models page` },
          cache: null,
          prices: [],
          catalog: null,
        }
      }
      const month = currentMonth()
      const [billing] = await Promise.all([billingReport({ ctx, billMonth: month, topNum: 10 })])
      return {
        route,
        configured: true,
        displayName: resolved.displayName,
        baseURL: resolved.baseURL,
        apiKeyEnv: resolved.apiKeyEnv ?? null,
        defaultModel: resolved.defaultModel,
        credentials,
        billing,
        cache: cacheReport(resolved, resolved.defaultModel),
        prices: priceRows(resolved),
        catalog: {
          modelCount: resolved.models.length,
          enabledCount: resolved.models.length - resolved.modelDisabled.length,
          disabled: [...resolved.modelDisabled],
          provenance: CATALOG_PROVENANCE,
        },
      }
    },
  }
}
