/**
 * Offline checks for the page's overview projections.
 *
 * Run with: `node tests/overview.test.mjs`
 *
 * @module @local/dsh-llm-bailian-native/tests/overview
 */

import assert from 'node:assert/strict'

import { defaultProfile, resolveRoute } from '../lib/config.js'
import { buildOverview, cacheSavings, catalogView, priceTable, probeView } from '../lib/overview.js'

let passed = 0
let failed = 0

/** @param {string} label @param {() => void | Promise<void>} body */
async function test(label, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok   ${label}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const route = resolveRoute('bailian-native', defaultProfile())

process.stdout.write('overview projections\n')

await test('lists every catalog model with its price provenance', () => {
  const rows = priceTable(route)
  assert.equal(rows.length, route.models.length)
  const max = rows.find((row) => row.model === 'qwen3.8-max')
  assert.equal(max.source, 'official')
  assert.equal(max.verified, true)
  assert.ok(String(max.sourceUrl).startsWith('https://'))
  assert.equal(max.cacheHit, null)
  assert.equal(max.cacheHitPublished, false, 'an unpublished cache price must not read as published')
  assert.deepEqual(max.inputModalities, ['text'])
})

await test('carries the route/alias price tier rows through', () => {
  const flash = priceTable(route).find((row) => row.model === 'qwen3.7-flash')
  assert.ok(Array.isArray(flash.tiers) && flash.tiers.length === 2)
  assert.equal(flash.tiers[0].aboveInputTokens, 32768)
})

await test('a cache hit is cheaper, and the saving is reported with its caveat', () => {
  const saving = cacheSavings(route)
  assert.ok(saving.warmCost < saving.coldCost, `warm ${saving.warmCost} must be below cold ${saving.coldCost}`)
  assert.ok(saving.savedAmount > 0)
  assert.ok(saving.savedPercent > 0)
  assert.ok(saving.fullyCachedCost < saving.warmCost)
  assert.equal(saving.cacheHitPublished, false)
  assert.equal(saving.cacheHitDerived, true, 'an unpublished rate is derived, and says so')
  assert.equal(saving.approximate, true)
  assert.match(saving.note ?? '', /implicit-cache rule/)
  // 1024 of 1231 prompt tokens cached at 20% of the input rate.
  assert.equal(Math.round(saving.savedPercent * 10) / 10, 66.4)
})

await test('clamps a nonsense sample instead of producing a negative cost', () => {
  const saving = cacheSavings(route, { cachedTokens: 99999, promptTokens: 100 })
  assert.ok(saving.warmCost >= 0)
  assert.ok(saving.cachedTokens <= saving.promptTokens)
})

await test('reports catalog state, and names models only the endpoint advertised', () => {
  const view = catalogView(route, { at: 1791795000000, models: [{ id: 'qwen3.8-max' }, { id: 'brand-new-model' }] })
  assert.equal(view.lastRefreshedAt, 1791795000000)
  assert.equal(view.refreshedCount, 2)
  assert.deepEqual(view.onlyAdvertised, ['brand-new-model'])
  assert.equal(view.modelCount, route.models.length)
  assert.ok(view.provenance.checkedAt === undefined || typeof view.provenance === 'object')
})

await test('says "no refresh yet" rather than pretending the catalog is fresh', () => {
  const view = catalogView(route, undefined)
  assert.equal(view.lastRefreshedAt, null)
  assert.equal(view.refreshError, null)
})

await test('an absent probe explains itself instead of rendering empty', () => {
  const view = probeView(undefined)
  assert.equal(view.available, false)
  assert.match(view.reason, /no self-check/)
  const ran = probeView({ at: 1, result: { ok: true, message: 'fine' } })
  assert.equal(ran.available, true)
  assert.equal(ran.ok, true)
})

await test('the billing panel states the credential boundary and the measured evidence', () => {
  const overview = buildOverview({ route })
  const billing = overview.billing
  assert.equal(billing.available, false)
  assert.deepEqual(billing.needs, ['accessKeyIdRef', 'accessKeySecretRef'])
  assert.match(billing.reason, /control-plane/)
  assert.equal(billing.operations.length, 2)
  assert.ok(billing.dimensions.includes('BASE_MODEL'), 'reconciliation is grouped by BASE_MODEL')
  assert.match(billing.evidence.modelKeyAsAccessKeyId, /InvalidAccessKeyId/)
  assert.match(billing.evidence.modelKeyAsBearer, /MissingAccessKeyId/)
})

await test('a referenced AccessKey pair is echoed back by name, never by value', () => {
  const overview = buildOverview({ route, billingRefs: { accessKeyId: 'ALIYUN_AK_ID', accessKeySecret: 'ALIYUN_AK_SECRET' } })
  assert.equal(overview.billing.configured.accessKeyIdRef, 'ALIYUN_AK_ID')
  assert.equal(overview.billing.configured.accessKeySecretRef, 'ALIYUN_AK_SECRET')
})

await test('assembles one payload with every panel present', () => {
  const overview = buildOverview({ route })
  for (const key of ['route', 'protocol', 'displayName', 'baseURL', 'apiKeyEnv', 'defaultModel', 'pricing', 'cache', 'catalog', 'probe', 'billing']) {
    assert.ok(key in overview, `overview is missing ${key}`)
  }
  assert.equal(overview.route, 'bailian-native')
  assert.equal(overview.protocol, 'dashscope-native')
  assert.equal(overview.apiKeyEnv, 'DASHSCOPE_API_KEY')
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
