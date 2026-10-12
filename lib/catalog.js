/**
 * Bundled, versioned model catalog and price table.
 *
 * Two independent things live here, with **different trust levels**:
 *
 * 1. `CATALOG` — which models exist, their names, windows and modalities. Used
 *    as the fallback when `GET /api/v1/models` cannot be reached. This list is a
 *    curated subset of the documented catalog, not the whole of it; discovery is
 *    the authoritative path.
 *
 * 2. `PRICE_TABLE` — the local billing price table. This is an **estimate, not a
 *    bill**. `priceSource` per row records where a number came from:
 *      - `'official'`: read off Alibaba Cloud's price page on `checkedAt`.
 *      - `'official-derived'`: computed from a published rule (e.g. the cache
 *        rules) rather than printed as an absolute number.
 *      - `'user'`: set through config `pricing`, authoritative for local billing.
 *      - `'bundled-unverified'`: placeholder, not confirmed.
 *
 * ## Why a local estimate at all
 *
 * A Bailian API key cannot query bills or balance: the native protocol's
 * billing-adjacent endpoints are only `GET /api/v1/models` (catalog, and it does
 * carry `prices[]`) and `GET /api/v1/models/limits` (RPM/TPM **quota**, not
 * money). Real reconciliation needs Aliyun BSS OpenAPI with AccessKey
 * ID/Secret — see README.md, "Billing boundary". Real bills are also *lower*
 * than this table in practice, because list price excludes promotions, off-peak
 * discounts and savings plans: treat any local cost as an upper bound.
 *
 * ## Published pricing rules this table encodes
 *
 * - Unit: **per 1,000,000 tokens**. China mainland rows are **CNY**; the
 *   International site publishes USD rows for the same models. Never mix them.
 * - **Tiering is by the request's total input tokens, and *all* tokens are then
 *   billed at that tier's rate** — it is not a progressive/marginal scale.
 * - Prompt cache: explicit cache **creation** = 125 % of the input price,
 *   explicit cache **hit** = 10 %, implicit cache hit = 20 %. Batch is 50 % but
 *   **does not combine with a cache discount**.
 *   Exceptions where the published rule does *not* hold — `qwen3.8-max`,
 *   `qwen3.8-flash`, `qwen3.8-2.4t-a95b` — carry `cacheHit: null`, which means
 *   **unknown**, not free. The ledger then marks the call's cost approximate
 *   instead of inventing a number.
 * - Vision models bill images as input tokens using
 *   `smart_resize(h, w, 32, min_pixels, max_pixels)` then
 *   `tokens = int(h*w/(32*32)) + 2`, default cap 1280 tokens/image and up to
 *   16384 with `vl_high_resolution_images`.
 *
 * @module @local/dsh-llm-bailian-native/catalog
 */

/** Bump when CATALOG or PRICE_TABLE changes shape or contents. */
export const CATALOG_VERSION = 2

/** Provenance for the bundled numbers, shown in the UI and README. */
export const CATALOG_PROVENANCE = Object.freeze({
  catalogCheckedAt: '2026-10-12',
  priceCheckedAt: '2026-10-12',
  priceDocumentUpdated: '2026-10-11',
  priceSourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  cacheRuleUrl: 'https://help.aliyun.com/zh/model-studio/context-cache',
  visionTokenRuleUrl: 'https://help.aliyun.com/zh/model-studio/vision-model',
  currency: 'CNY',
  region: 'cn-beijing',
  note: 'Prices are China-mainland (Beijing) list prices in CNY per 1M tokens, read 2026-10-12 from a price page stamped 2026-10-11. List price excludes promotions, off-peak and savings plans, so a local estimate is an upper bound.',
})

/**
 * @typedef {object} CatalogEntry
 * @property {string} vendor
 * @property {string} protocol
 * @property {string} id
 * @property {string} name
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {ReadonlyArray<'text' | 'image'>} inputModalities
 * @property {Record<string, number>} [thinkingBudgets]
 * @property {string} source
 */

/**
 * Curated fallback catalog.
 *
 * `qwen-turbo`, `qwen-vl-max`, `qwen-vl-plus` and the `qwen2.5-vl` line are
 * deliberately **absent**: they no longer appear in the current model or price
 * documentation, so bundling them would advertise models this adapter cannot
 * promise. The `qwen-plus` / `qwen-max` / `qwen-flash` aliases *are* included
 * because they remain documented legacy aliases.
 * @type {ReadonlyArray<CatalogEntry>}
 */
export const CATALOG = Object.freeze([
  // --- Aliyun Bailian / DashScope, native protocol -------------------------
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.8-max',
    name: 'Qwen3.8 Max',
    contextWindow: 262144,
    maxTokens: 65536,
    inputModalities: ['text'],
    thinkingBudgets: { low: 4096, high: 16384, max: 131072 },
    source: 'text-generation model list (flagship; thinking-capable)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.8-flash',
    name: 'Qwen3.8 Flash',
    contextWindow: 262144,
    maxTokens: 32768,
    inputModalities: ['text'],
    thinkingBudgets: { low: 4096, high: 16384, max: 131072 },
    source: 'text-generation model list',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.7-plus',
    name: 'Qwen3.7 Plus',
    contextWindow: 1000000,
    maxTokens: 32768,
    inputModalities: ['text'],
    thinkingBudgets: { low: 1024, high: 8192, max: 32768 },
    source: 'text-generation model list (1M-token tier documented)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.7-flash',
    name: 'Qwen3.7 Flash',
    contextWindow: 1000000,
    maxTokens: 32768,
    inputModalities: ['text'],
    source: 'text-generation model list (tiered pricing)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen-long',
    name: 'Qwen Long',
    contextWindow: 10000000,
    maxTokens: 8192,
    inputModalities: ['text'],
    source: 'text-generation model list (long-context)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen-plus',
    name: 'Qwen Plus（legacy alias）',
    contextWindow: 1000000,
    maxTokens: 32768,
    inputModalities: ['text'],
    thinkingBudgets: { low: 1024, high: 8192, max: 32768 },
    source: 'legacy alias, documented as equivalent to a dated snapshot',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen-max',
    name: 'Qwen Max（legacy alias）',
    contextWindow: 131072,
    maxTokens: 8192,
    inputModalities: ['text'],
    source: 'legacy alias, documented as equivalent to a dated snapshot',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen-flash',
    name: 'Qwen Flash（legacy alias）',
    contextWindow: 1000000,
    maxTokens: 32768,
    inputModalities: ['text'],
    source: 'legacy alias, documented as equivalent to a dated snapshot',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3-vl-plus',
    name: 'Qwen3 VL Plus',
    contextWindow: 262144,
    maxTokens: 32768,
    inputModalities: ['text', 'image'],
    source: 'vision model list (current first-class VL model)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.8-omni-flash',
    name: 'Qwen3.8 Omni Flash',
    contextWindow: 1000000,
    maxTokens: 32768,
    inputModalities: ['text', 'image'],
    source: 'vision/omni model list (native coverage is the multimodal path)',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3-omni-flash',
    name: 'Qwen3 Omni Flash',
    contextWindow: 262144,
    maxTokens: 32768,
    inputModalities: ['text', 'image'],
    source: 'vision/omni model list',
  },
  {
    vendor: 'aliyun',
    protocol: 'dashscope-native',
    id: 'qwen3.5-ocr',
    name: 'Qwen3.5 OCR',
    contextWindow: 262144,
    maxTokens: 8192,
    inputModalities: ['text', 'image'],
    source: 'vision model list (OCR-focused)',
  },
])

/** Model ids that ship enabled for a fresh `dashscope-native` route. */
export const DEFAULT_ENABLED_MODELS = Object.freeze(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-vl-plus'])

/**
 * One price row. `cacheHit: null` means **unknown** — the provider's published
 * rule does not cover this model and the docs defer to the console. Consumers
 * must not treat `null` as zero.
 *
 * @typedef {object} PriceRow
 * @property {number} cacheMiss  uncached input, per 1M tokens
 * @property {number | null} cacheHit  cache-read input, per 1M tokens
 * @property {number} output     completion, per 1M tokens
 * @property {string} currency
 * @property {string} source
 * @property {boolean} verified
 * @property {string} [sourceUrl]
 * @property {string} [checkedAt]
 *
 * @type {Readonly<Record<string, PriceRow>>}
 */
export const PRICE_TABLE = Object.freeze({
  // Verified from the China-mainland (Beijing) price page, CNY per 1M tokens.
  'qwen3.8-max': {
    cacheMiss: 12, cacheHit: null, output: 36, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3.8-flash': {
    cacheMiss: 0.8, cacheHit: null, output: 2.7, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3.7-plus': {
    // List 2/8; a documented limited-time 20 % discount makes it 1.6/6.4. List
    // is recorded because a promotion can end without notice.
    cacheMiss: 2, cacheHit: 0.4, output: 8, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3.7-flash': {
    cacheMiss: 0.2, cacheHit: 0.04, output: 0.8, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen-max': {
    cacheMiss: 2.4, cacheHit: 0.48, output: 9.6, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen-plus': {
    // Thinking output is priced above non-thinking output; the non-thinking
    // figure is recorded, which under-estimates a thinking call.
    cacheMiss: 0.8, cacheHit: 0.16, output: 2, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3-vl-plus': {
    cacheMiss: 1, cacheHit: 0.2, output: 10, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3.8-omni-flash': {
    // One of the few models with an absolute published cache-hit price.
    cacheMiss: 0.8, cacheHit: 0.1, output: 2.7, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen3.5-ocr': {
    cacheMiss: 0.5, cacheHit: 0.1, output: 2, currency: 'CNY', source: 'official', verified: true,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing', checkedAt: '2026-10-12',
  },
  'qwen-flash': {
    cacheMiss: 0.15, cacheHit: 0.03, output: 0.6, currency: 'CNY', source: 'bundled-unverified', verified: false,
  },
  'qwen-long': {
    cacheMiss: 0.5, cacheHit: 0.1, output: 2, currency: 'CNY', source: 'bundled-unverified', verified: false,
  },
  'qwen3-omni-flash': {
    cacheMiss: 0.3, cacheHit: 0.06, output: 1.2, currency: 'CNY', source: 'bundled-unverified', verified: false,
  },
})

/**
 * Input-token tiers: above `aboveInputTokens`, every token of the request is
 * billed at these rates instead of the base row's.
 *
 * Published rule: the tier is selected by the request's total input tokens and
 * then applies to all of them.
 * @type {Readonly<Record<string, ReadonlyArray<{ aboveInputTokens: number, cacheMiss: number, cacheHit: number | null, output: number }>>>}
 */
export const PRICE_TIERS = Object.freeze({
  'qwen3.7-plus': [
    { aboveInputTokens: 262144, cacheMiss: 6, cacheHit: 1.2, output: 24 },
  ],
  'qwen3.7-flash': [
    { aboveInputTokens: 32768, cacheMiss: 0.6, cacheHit: 0.12, output: 2.4 },
    { aboveInputTokens: 262144, cacheMiss: 1.2, cacheHit: 0.24, output: 4.8 },
  ],
  'qwen-plus': [
    { aboveInputTokens: 131072, cacheMiss: 2.4, cacheHit: 0.48, output: 20 },
    { aboveInputTokens: 262144, cacheMiss: 4.8, cacheHit: 0.96, output: 48 },
  ],
  'qwen3-vl-plus': [
    { aboveInputTokens: 32768, cacheMiss: 1.5, cacheHit: 0.3, output: 15 },
    { aboveInputTokens: 131072, cacheMiss: 3, cacheHit: 0.6, output: 30 },
  ],
})

/**
 * Published prompt-cache rules, used to derive a `cacheHit` price for a row that
 * has none, and to explain the number in the UI.
 *
 * Explicit cache: creation 125 % of input, hit 10 %. Implicit cache: hit 20 %.
 * A derived number is marked `official-derived` so it is never mistaken for a
 * printed price.
 */
export const CACHE_RULES = Object.freeze({
  explicitWriteRatio: 1.25,
  explicitHitRatio: 0.1,
  implicitHitRatio: 0.2,
  /** Models whose published cache price is explicitly excluded from the rule. */
  exceptions: Object.freeze(['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b']),
  sourceUrl: 'https://help.aliyun.com/zh/model-studio/context-cache',
})

/** Batch inference halves both input and output for tagged models. */
export const BATCH_DISCOUNT = 0.5

/**
 * The catalog entries a given protocol can serve.
 * @param {string} protocol
 * @returns {CatalogEntry[]}
 */
export function catalogFor(protocol) {
  return CATALOG.filter((entry) => entry.protocol === protocol)
}

/**
 * Resolve a model id to the key its price row lives under, following the
 * documented alias/snapshot relationship. `snapshotOf` comes from the catalog
 * endpoint's `equivalent_snapshot`, so a rolling alias and its dated snapshot
 * bill identically even when only one of them is in this table.
 *
 * @param {string} model
 * @param {{ snapshotOf?: string }} [hints]
 * @returns {string | undefined}
 */
export function priceKeyFor(model, hints) {
  if (PRICE_TABLE[model] !== undefined) return model
  if (typeof hints?.snapshotOf === 'string' && PRICE_TABLE[hints.snapshotOf] !== undefined) return hints.snapshotOf
  // Otherwise the longest table key this id extends, so `qwen3.8-max-0902`
  // inherits `qwen3.8-max`.
  return Object.keys(PRICE_TABLE)
    .filter((key) => model.startsWith(`${key}-`))
    .sort((left, right) => right.length - left.length)[0]
}

/**
 * Bundled price for one exact model id, or `undefined` when the table has none.
 * @param {string} model
 * @param {{ snapshotOf?: string }} [hints]
 * @returns {PriceRow | undefined}
 */
export function bundledPrice(model, hints) {
  const key = priceKeyFor(model, hints)
  return key === undefined ? undefined : PRICE_TABLE[key]
}

/**
 * Input-token tiers for one model id, if it has any.
 * @param {string} model
 * @param {{ snapshotOf?: string }} [hints]
 */
export function bundledTiers(model, hints) {
  const key = priceKeyFor(model, hints)
  return key === undefined ? undefined : PRICE_TIERS[key]
}
