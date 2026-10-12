/**
 * Read-only overview projections for the plugin's settings page.
 *
 * Everything here is a pure function of already-resolved configuration and the
 * last catalog refresh, so the page needs no privileged host call to show it —
 * and it can be asserted offline (`tests/overview.test.mjs`).
 *
 * The two panels that *do* require inference-time state — "advertised vs local
 * price" and "connectivity self-check" — expose an explicit `unavailable` shape
 * with a reason, rather than silently rendering nothing.
 *
 * @module @local/dsh-llm-bailian-native/overview
 */

import { CATALOG_PROVENANCE, CACHE_RULES } from './catalog.js'
import { computeCost, priceFor } from './config.js'

/** The cache rule the local estimate uses, in the form the page renders. */
export const CACHE_EXPLANATION = Object.freeze({
  implicitHitRatio: CACHE_RULES.implicitHitRatio,
  explicitHitRatio: CACHE_RULES.explicitHitRatio,
  explicitWriteRatio: CACHE_RULES.explicitWriteRatio,
  exceptions: [...CACHE_RULES.exceptions],
  sourceUrl: CACHE_RULES.sourceUrl,
})

/**
 * The price table for one route, one row per catalog model, with provenance.
 *
 * `cacheHit: null` is carried through as **unknown** — the page must render it
 * as "not published", never as zero, because the two mean opposite things to a
 * cost.
 *
 * @param {import('./config.js').ResolvedRoute} route
 * @returns {Array<Record<string, unknown>>}
 */
export function priceTable(route) {
  return route.models.map((entry) => {
    const hints = entry.snapshotOf === undefined ? undefined : { snapshotOf: entry.snapshotOf }
    const price = priceFor(route, entry.id, hints)
    return {
      model: entry.id,
      name: entry.name ?? entry.id,
      enabled: !route.modelDisabled.includes(entry.id),
      contextWindow: entry.contextWindow ?? null,
      maxTokens: entry.maxTokens ?? null,
      inputModalities: entry.inputModalities ?? ['text'],
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
 * Worked examples of what a prompt-cache hit actually saves on this route.
 *
 * Uses the measured real-world ratio from a live check (1024 of 1231 prompt
 * tokens served from cache, `qwen3.8-flash`) plus a fully-cached case, so the
 * page can show a concrete number instead of a rule.
 *
 * @param {import('./config.js').ResolvedRoute} route
 * @param {{ model?: string, promptTokens?: number, cachedTokens?: number, outputTokens?: number }} [sample]
 */
export function cacheSavings(route, sample = {}) {
  const model = sample.model ?? route.defaultModel ?? route.models[0]?.id
  const promptTokens = sample.promptTokens ?? 1231
  const cachedTokens = Math.min(sample.cachedTokens ?? 1024, promptTokens)
  const outputTokens = sample.outputTokens ?? 1
  const entry = route.models.find((candidate) => candidate.id === model)
  const hints = entry?.snapshotOf === undefined ? undefined : { snapshotOf: entry.snapshotOf }
  const price = priceFor(route, model, hints)

  const cold = computeCost({ inputTokens: promptTokens, outputTokens }, price)
  const warm = computeCost({ inputTokens: promptTokens, outputTokens, cacheReadTokens: cachedTokens }, price)
  const fullyCached = computeCost({ inputTokens: promptTokens, outputTokens, cacheReadTokens: promptTokens }, price)
  const percent = (from, to) => (from > 0 ? Math.round((1 - to / from) * 1000) / 10 : 0)

  return {
    model,
    promptTokens,
    cachedTokens,
    outputTokens,
    currency: price.currency,
    cacheHitPublished: price.cacheHit !== null,
    cacheHitDerived: warm.cacheHitDerived,
    effectiveCacheRate: warm.cacheHitRate,
    uncachedInputRate: price.cacheMiss,
    coldCost: cold.cost,
    warmCost: warm.cost,
    fullyCachedCost: fullyCached.cost,
    savedAmount: warm.cacheSavings,
    savedPercent: percent(cold.cost, warm.cost),
    fullyCachedPercent: percent(cold.cost, fullyCached.cost),
    approximate: warm.approximate,
    note: warm.note ?? null,
  }
}

/**
 * The catalog as the model picker sees it, plus the endpoints that were tried.
 * @param {import('./config.js').ResolvedRoute} route
 * @param {{ at?: number, models?: unknown[], error?: string } | undefined} discovery
 */
export function catalogView(route, discovery) {
  const discovered = Array.isArray(discovery?.models) ? discovery.models : []
  const discoveredIds = new Set(discovered.map((entry) => String(entry?.id ?? '')).filter((id) => id.length > 0))
  const localIds = new Set(route.models.map((entry) => entry.id))
  return {
    protocols: [route.protocol],
    baseURL: route.baseURL,
    generationPath: route.generationPath,
    modelCount: route.models.length,
    enabledCount: route.models.length - route.modelDisabled.length,
    disabled: [...route.modelDisabled],
    lastRefreshedAt: typeof discovery?.at === 'number' ? discovery.at : null,
    refreshedCount: discovered.length,
    refreshError: discovery?.error ?? null,
    /** Models the endpoint advertised that the local catalog does not know. */
    onlyAdvertised: [...discoveredIds].filter((id) => !localIds.has(id)),
    provenance: CATALOG_PROVENANCE,
  }
}

/**
 * The connectivity panel's data, from the last recorded probe.
 * @param {{ at?: number, result?: Record<string, unknown> } | undefined} probe
 */
export function probeView(probe) {
  if (probe === undefined || probe.result === undefined) {
    return {
      available: false,
      reason: 'no self-check has run yet in this session',
      hint: 'run a self-check to confirm the credential reference, the origin and the model catalog in one call',
    }
  }
  return { available: true, at: probe.at ?? null, ...probe.result }
}

/**
 * Why the billing panel cannot work with the model key, with the evidence.
 *
 * Measured on 2026-10-12 against `modelstudio.cn-beijing.aliyuncs.com`: the
 * model key was sent as `Authorization: Bearer sk-…` (with and without the
 * Aliyun `Date`/`x-acs-action`/`x-acs-version` headers) and also used as the
 * `AccessKeyId` inside an ACS3 signature. The gateway answered the same
 * `MissingAccessKeyId` for the Bearer attempts as it did for a request with no
 * `Authorization` header at all, i.e. it ignores the model key entirely, and
 * `InvalidAccessKeyId.NotFound` when the key was used as an AccessKey.
 *
 * @param {{ accessKeyId?: string, accessKeySecret?: string }} [references]
 */
export function billingView(references = {}) {
  return {
    available: false,
    needs: ['accessKeyIdRef', 'accessKeySecretRef'],
    configured: {
      accessKeyIdRef: typeof references.accessKeyId === 'string' && references.accessKeyId.length > 0 ? references.accessKeyId : null,
      accessKeySecretRef: typeof references.accessKeySecret === 'string' && references.accessKeySecret.length > 0 ? references.accessKeySecret : null,
    },
    reason: 'the billing OpenAPI is an Aliyun gateway (control-plane) API signed with AccessKey ID/Secret; the Bailian model key is a data-plane credential and the gateway ignores it',
    operations: [
      { action: 'GetBillingOverview', path: '/modelstudio/billing/overview', required: ['billMonth', 'groupBy[].code (exactly one)'] },
      { action: 'GetBillingTrend', path: '/modelstudio/billing/trend', required: ['granularity (DAY|MONTH)', 'timePeriod.start/end', 'groupBy[].code'] },
    ],
    dimensions: ['BASE_MODEL', 'API_KEY_ID', 'WORKSPACE_ID', 'MAAS_TYPE', 'CHARGE_TYPE', 'BUSINESS_REGION', 'SERVICE_SITE', 'FEE_TYPE', 'ARTICLE_CODE'],
    reconciliation: 'compare the local token estimate with the billed amount grouped by BASE_MODEL',
    evidence: {
      checkedAt: '2026-10-12',
      host: 'modelstudio.cn-beijing.aliyuncs.com',
      modelKeyAsBearer: 'MissingAccessKeyId (identical to a request with no Authorization header)',
      modelKeyAsAccessKeyId: 'InvalidAccessKeyId.NotFound',
    },
    setup: 'create a RAM user with a read-only billing policy, store the AccessKey ID/Secret through the credentials seam, and reference them here by name',
    docs: [
      'https://www.alibabacloud.com/help/en/model-studio/api-modelstudio-2026-02-10-getbillingoverview',
      'https://www.alibabacloud.com/help/en/model-studio/api-modelstudio-2026-02-10-getbillingtrend',
      'https://help.aliyun.com/zh/model-studio/roa-style-request-body-signature-mechanism',
    ],
  }
}

/**
 * Assemble the whole page payload for one route.
 * @param {object} input
 * @param {import('./config.js').ResolvedRoute} input.route
 * @param {{ at?: number, models?: unknown[], error?: string }} [input.discovery]
 * @param {{ at?: number, result?: Record<string, unknown> }} [input.probe]
 * @param {{ accessKeyId?: string, accessKeySecret?: string }} [input.billingRefs]
 */
export function buildOverview({ route, discovery, probe, billingRefs }) {
  return {
    route: route.route,
    protocol: route.protocol,
    displayName: route.displayName,
    baseURL: route.baseURL,
    apiKeyEnv: route.apiKeyEnv ?? null,
    defaultModel: route.defaultModel,
    generationPath: route.generationPath,
    pricing: priceTable(route),
    cache: { explanation: CACHE_EXPLANATION, savings: cacheSavings(route) },
    catalog: catalogView(route, discovery),
    probe: probeView(probe),
    billing: billingView(billingRefs),
  }
}
