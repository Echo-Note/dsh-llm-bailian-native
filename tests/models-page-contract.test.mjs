/**
 * End-to-end check of the side of the contract the **Models settings page**
 * consumes — without mounting the harness.
 *
 * The plugin is applied to a stub context that records exactly what it registers:
 *
 *   1. `ctx.llm.registerConfigurableProviders(entries)` → the row the Models page
 *      renders, including `settingsPath: ['providers','bailian-native']` so the
 *      page's config form reads and writes the right section;
 *   2. `ctx.llm.registerModelDiscovery(settingsNs, …)` → the "fetch available
 *      models" button for that row;
 *   3. `ctx.llm.registerAdapter(routes, adapter)` → the inference route, asserted
 *      against the seven methods the registry duck-types.
 *
 * Run with: `node tests/models-page-contract.test.mjs`
 *
 * @module @local/dsh-llm-bailian-native/tests/models-page-contract
 */

import assert from 'node:assert/strict'

import { Config, defaultProfile } from '../lib/config.js'
import { apply } from '../lib/index.js'

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

/**
 * Mount the plugin on a stub context that behaves like the parts of the harness
 * it talks to.
 * @param {Record<string, unknown>} providersConfig
 */
function mount(providersConfig) {
  const state = {
    adapterRoutes: null,
    adapter: null,
    directory: null,
    discoveryNs: null,
    discovery: null,
    settingsConfigured: null,
    registeredTools: [],
    loggerErrors: [],
  }

  /** @type {any} */
  const ctx = {
    fiber: { entry: { options: { id: 'llm-bailian-native' } } },
    effect: (fn) => {
      fn()
      return () => {}
    },
    // Only 'settings' and 'tools' are optional services for this plugin; the
    // composition mounts settings, so its callback must run.
    inject: (names, callback) => {
      const list = Array.isArray(names) ? names : [names]
      const child = { ...ctx }
      if (list.includes('settings')) {
        child.settings = { configure: (presentation) => { state.settingsConfigured = presentation } }
      }
      if (list.includes('tools')) {
        child.tools = { register: (definition) => { state.registeredTools.push(definition); return () => {} } }
      }
      if (list.every((name) => child[name] !== undefined)) callback(child)
      return () => {}
    },
    get: (name) => (name === 'settings' ? ctx.settings : name === 'credentials' ? undefined : undefined),
    on: () => () => {},
    logger: {
      warn: () => {},
      error: (...args) => state.loggerErrors.push(args),
    },
    llm: {
      registerAdapter: (routes, adapter) => {
        state.adapterRoutes = routes
        state.adapter = adapter
        return Object.assign(() => {}, { replace: (next) => { state.adapterRoutes = next } })
      },
      registerConfigurableProviders: (entries) => {
        state.directory = entries
        return Object.assign(() => {}, { replace: (next) => { state.directory = next } })
      },
      registerModelDiscovery: (ns, discover) => {
        state.discoveryNs = ns
        state.discovery = discover
        return () => {}
      },
    },
  }

  apply(ctx, Config({ providers: providersConfig }))
  return state
}

process.stdout.write('models-page contract\n')

await test('a configured route becomes a Models-page row pointing at the right settings section', () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.ok(Array.isArray(state.directory), 'the plugin must register a configurable-provider directory')
  const row = state.directory.find((entry) => entry.provider === 'bailian-native')
  assert.ok(row, 'the Models page needs a row for the route')
  assert.equal(row.settingsNs, 'llm-bailian-native')
  assert.deepEqual(row.settingsPath, ['providers', 'bailian-native'], 'the row must address the config section the page edits')
  assert.equal(row.declared, false, 'a route this plugin can serve is not a hand-declared one')
  assert.equal(row.error, undefined)
})

await test('the dormant default is still adoptable from the Models page', () => {
  // A third-party provider ships dormant: no stored profile, yet the page must
  // offer it so the user can activate it. That is what `declared: true` means.
  const state = mount({})
  const row = state.directory.find((entry) => entry.provider === 'bailian-native')
  assert.ok(row, 'the page must offer an unconfigured route')
  assert.equal(row.declared, true)
  assert.deepEqual(row.settingsPath, ['providers', 'bailian-native'])
})

await test('a misconfigured route keeps its diagnostic in the row', () => {
  const state = mount({ 'bailian-native': { protocol: 'dashscope-native', baseURL: 'not-a-url' } })
  const row = state.directory.find((entry) => entry.provider === 'bailian-native')
  assert.ok(row, 'a broken route must still be visible and editable')
  assert.match(row.error ?? '', /not a valid URL/)
  assert.equal(row.declared, true)
})

await test('a reserved vendor protocol is reported as an unimplemented integration point', () => {
  const state = mount({ 'tencent-route': { protocol: 'tencent-native', baseURL: 'https://example.com' } })
  const row = state.directory.find((entry) => entry.provider === 'tencent-route')
  assert.match(row.error ?? '', /reserved integration point/)
})

await test('model discovery is offered for the namespace the row uses', () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.equal(state.discoveryNs, 'llm-bailian-native', 'discovery is keyed by the settings namespace, not the route')
  assert.equal(typeof state.discovery, 'function')
})

await test('the adapter implements every method the registry duck-types', () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.deepEqual(state.adapterRoutes, ['bailian-native'], 'the route must be registered for inference')
  for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
    assert.equal(typeof state.adapter[method], 'function', `adapter is missing ${method}()`)
  }
  assert.deepEqual(state.adapter.providerInfo('bailian-native'), { id: 'bailian-native', name: '阿里云百炼（原生协议）' })
})

await test('the adapter advertises the route catalog to the model picker', async () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  const models = await state.adapter.listModels('bailian-native')
  assert.ok(models.length > 0, 'the picker needs at least one model')
  for (const model of models) {
    assert.equal(model.provider, 'bailian-native', 'every entry must preserve its provider id')
    assert.ok(typeof model.id === 'string' && model.id.length > 0)
    assert.ok(typeof model.name === 'string' && model.name.length > 0)
    assert.ok(Array.isArray(model.inputModalities), 'input modalities decide image admission downstream')
  }
  assert.ok(models.some((model) => model.id === 'qwen3.8-max'))
})

await test('a disabled model is hidden from the picker but kept in the catalog', async () => {
  const profile = { ...defaultProfile(), modelDisabled: ['qwen3.8-max'] }
  const state = mount({ 'bailian-native': profile })
  const models = await state.adapter.listModels('bailian-native')
  assert.ok(!models.some((model) => model.id === 'qwen3.8-max'), 'a disabled model must not be offered')
  assert.ok(models.some((model) => model.id === 'qwen3.8-flash'), 'the rest of the catalog survives')
})

await test('exact-model resolution reports the context window and reasoning efforts', async () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  const info = await state.adapter.resolveModel('bailian-native', 'qwen3.8-max')
  assert.equal(info.provider, 'bailian-native')
  assert.equal(info.id, 'qwen3.8-max')
  assert.ok(info.context.contextWindow > 0)
  assert.deepEqual(info.reasoning.efforts.map((effort) => effort.id), ['off', 'low', 'high', 'max'])
})

await test('the adapter declares no image pricing for a text-only model', () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.equal(state.adapter.imageRequestPricing('bailian-native', 'qwen3.8-max'), undefined)
  const priced = state.adapter.imageRequestPricing('bailian-native', 'qwen3-vl-plus')
  assert.ok(priced && typeof priced.visualTokens === 'number', 'a vision route must declare request image pricing')
})

await test('the plugin registers no agent tool of its own', () => {
  // It is a provider, not a management surface: configuration belongs to the
  // Models page, which addresses the same settings section.
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.deepEqual(state.registeredTools, [])
})

await test('the plugin opts out of a hand-written automatic settings page', () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  assert.deepEqual(state.settingsConfigured, { auto: false })
})

await test('the price table is exposed for the statistics plugins, with provenance', async () => {
  const state = mount({ 'bailian-native': defaultProfile() })
  const rows = state.adapter.priceTable('bailian-native')
  assert.ok(rows.length > 0)
  const max = rows.find((row) => row.model === 'qwen3.8-max')
  assert.equal(max.source, 'official')
  assert.equal(max.verified, true)
  assert.equal(max.cacheHit, null, 'an unpublished cache price is unknown, never zero')
  assert.ok(max.sourceUrl.startsWith('https://'), 'a price row must name where it came from')
  assert.deepEqual(state.adapter.providerRetryPolicy('bailian-native').retryableCodes.sort(), ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
