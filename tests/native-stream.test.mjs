/**
 * Offline checks for the native wire layer.
 *
 * Nothing here touches the network, DSH, or the file system: it drives the real
 * adapter and stream translator against synthetic DashScope payloads, including
 * the literal frames from Alibaba Cloud's streaming documentation. Run with:
 *
 *   node tests/native-stream.test.mjs
 *
 * @module @local/dsh-llm-bailian-native/tests/native-stream
 */

import assert from 'node:assert/strict'

import { dashscopeNative, generationPathFor, normalizeServiceRoot, visualTokensFor } from '../lib/providers/dashscope/native.js'
import { runNativeRequest, translateNativeStream } from '../lib/stream.js'

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

/** @param {string[]} frames */
function sseBody(frames) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

/** A native SSE frame exactly as the provider documents it. */
function frame(payload, id) {
  return `id:${id}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify(payload)}\n\n`
}

const route = {
  route: 'bailian-native',
  protocol: 'dashscope-native',
  displayName: 'test',
  baseURL: 'https://example.invalid',
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  headers: {},
  timeoutMs: 1000,
  streamIdleTimeoutMs: 60000,
  models: [{ id: 'qwen3.8-max', name: 'qwen3.8-max', contextWindow: 1000, maxTokens: 100, inputModalities: ['text'] }],
  modelDisabled: [],
  defaultModel: 'qwen3.8-max',
  defaultContextWindow: 1000,
  thinkingBudgets: {},
  generationPath: 'auto',
  generationPathOverrides: {},
  priceCurrency: 'CNY',
  priceOverrides: {},
  cacheCatalog: true,
  catalogRefreshMinutes: 0,
  multimodalFamilies: ['qwen3.8'],
}

/** @param {AsyncIterable<any>} chunks */
async function collect(chunks) {
  const out = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

process.stdout.write('native wire layer\n')

// The Config export must be a real schemastery schema: the settings service
// derives the Models-page form from it, and the loader validates the row's
// config with it. This also proves the vendored schema resolves end to end.
await test('exposes a usable schemastery Config that resolves a route', async () => {
  const { Config, defaultProfile, resolveRoute, priceFor, computeCost } = await import('../lib/config.js')
  const plugin = await import('../lib/index.js')
  assert.equal(plugin.Config, Config)
  const { providers } = Config({ providers: { 'bailian-native': defaultProfile() } })
  const raw = providers.get()
  assert.ok(raw['bailian-native'], 'the config snapshot must carry the route')
  const route = resolveRoute('bailian-native', raw['bailian-native'])
  assert.equal(route.protocol, 'dashscope-native')
  assert.equal(route.apiKeyEnv, 'DASHSCOPE_API_KEY')
  assert.ok(route.models.length > 0, 'the bundled catalog must resolve')
})

await test('resolves a price row and bills tiered usage at the tier rate', async () => {
  const { defaultProfile, resolveRoute, priceFor, computeCost } = await import('../lib/config.js')

  // qwen3.8-max has no *published* cache-read price, so the row keeps
  // `cacheHit: null` (unknown, never zero) and the billing derives the published
  // implicit-cache rule at use time, flagged approximate.
  const max = resolveRoute('bailian-native', defaultProfile())
  const maxPrice = priceFor(max, 'qwen3.8-max')
  assert.equal(maxPrice.cacheHit, null, 'an unpublished rate stays unknown in the table')
  assert.equal(maxPrice.source, 'official')
  // `inputTokens` is the request's total prompt size and `cacheReadTokens` is the
  // cached slice *of it*, so here every input token came from cache:
  //   uncached input 12 x 0 = 0, output 36 x 1 = 36, cached 1M x 2.4 = 2.4  ->  38.4
  const maxCost = computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, maxPrice)
  assert.equal(Math.round(maxCost.cost * 1e6) / 1e6, 38.4)
  assert.equal(maxCost.approximate, true, 'a derived cache rate makes the cost approximate')
  // A cache miss on the same prompt is strictly more expensive.
  const missCost = computeCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, maxPrice)
  assert.equal(Math.round(missCost.cost * 1e6) / 1e6, 48)

  // qwen3.7-flash is tiered: above 32k input tokens every token bills at tier 2.
  const flashPrice = priceFor(max, 'qwen3.7-flash')
  assert.equal(flashPrice.cacheMiss, 0.2)
  const below = computeCost({ inputTokens: 1000, outputTokens: 1000 }, flashPrice)
  assert.equal(Math.round(below.cost * 1e6) / 1e6, Math.round((1000 * 0.2 + 1000 * 0.8) / 1e6 * 1e6) / 1e6)
  const above = computeCost({ inputTokens: 40000, outputTokens: 0 }, flashPrice)
  assert.equal(above.tier, 32768)
  assert.equal(Math.round(above.cost * 1e6) / 1e6, Math.round((40000 * 0.6) / 1e6 * 1e6) / 1e6)

  // An unpriced model must not invent a cost.
  const unknown = priceFor(max, 'totally-unknown-model')
  assert.equal(unknown.source, 'none')
  assert.equal(computeCost({ inputTokens: 1000, outputTokens: 1000 }, unknown).cost, 0)
})

await test('a prompt-cache hit is cheaper than a miss, never double-counted', async () => {
  const { defaultProfile, resolveRoute, priceFor, computeCost } = await import('../lib/config.js')
  const route = resolveRoute('bailian-native', defaultProfile())
  for (const model of ['qwen3.8-flash', 'qwen3.8-max']) {
    const price = priceFor(route, model)
    // Measured on a real request: 1024 of 1231 prompt tokens were served from cache.
    const cold = computeCost({ inputTokens: 1231, outputTokens: 1 }, price)
    const warm = computeCost({ inputTokens: 1231, outputTokens: 1, cacheReadTokens: 1024 }, price)
    assert.ok(warm.cost < cold.cost, `${model}: a cache hit must cost less than a miss (cold ${cold.cost}, warm ${warm.cost})`)
    assert.ok(warm.cacheSavings > 0, `${model}: the saving must be reported`)
    // The uncached remainder is 1231 - 1024 = 207 tokens.
    assert.equal(warm.cacheHitRate, Math.round(price.cacheMiss * 0.2 * 1e6) / 1e6, `${model}: an unpublished cache rate uses the implicit 20% rule`)
    assert.equal(warm.cacheHitDerived, true)
    assert.equal(warm.approximate, true, 'a derived rate must be labelled approximate')
    assert.match(warm.note ?? '', /implicit-cache rule/)
  }
})

await test('cache accounting clamps to the reported prompt size', async () => {
  const { defaultProfile, resolveRoute, priceFor, computeCost } = await import('../lib/config.js')
  const price = priceFor(resolveRoute('bailian-native', defaultProfile()), 'qwen3.8-flash')
  // A provider that reports more cached than total tokens must not produce a
  // negative uncached remainder.
  const odd = computeCost({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 99 }, price)
  assert.ok(odd.cost >= 0)
  assert.ok(odd.cacheSavings <= (10 * price.cacheMiss) / 1e6 + 1e-12)
})

await test('rejects a broken route with an actionable diagnostic', async () => {
  const { resolveRoutes } = await import('../lib/config.js')
  const { routes, errors } = resolveRoutes({
    good: { protocol: 'dashscope-native', baseURL: 'https://dashscope.aliyuncs.com', apiKeyEnv: 'DASHSCOPE_API_KEY' },
    bad: { protocol: 'dashscope-native', baseURL: 'not a url' },
    reserved: { protocol: 'tencent-native', baseURL: 'https://example.com' },
  })
  assert.ok(routes.has('good'))
  assert.match(errors.get('bad'), /not a valid URL/)
  assert.match(errors.get('reserved'), /reserved integration point/)
})

process.stdout.write('\n' + '')
await test('normalizes a base URL copied from an OpenAI-compatible route', () => {
  assert.equal(normalizeServiceRoot('https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'), 'https://llm-x.cn-beijing.maas.aliyuncs.com')
  assert.equal(normalizeServiceRoot('https://dashscope.aliyuncs.com/api/v1'), 'https://dashscope.aliyuncs.com')
  assert.equal(normalizeServiceRoot('https://dashscope.aliyuncs.com/'), 'https://dashscope.aliyuncs.com')
  assert.equal(
    normalizeServiceRoot('https://gw.example/prefix/api/v1/services/aigc/text-generation/generation'),
    'https://gw.example/prefix',
  )
})

await test('routes the newest flagship families to the multimodal path', () => {
  assert.match(generationPathFor(route, 'qwen3.8-max').path, /multimodal-generation/)
  assert.match(generationPathFor(route, 'qwen3-vl-plus').path, /multimodal-generation/)
  assert.match(generationPathFor({ ...route, generationPathOverrides: {}, multimodalFamilies: [] }, 'qwen-max').path, /text-generation/)
})

await test('honours an explicit path override', () => {
  const pinned = { ...route, generationPath: 'text' }
  assert.match(generationPathFor(pinned, 'qwen3.8-max').path, /text-generation/)
})

await test('computes visual tokens with the published 32px rule', () => {
  // 1024x1024 -> int(1024*1024/1024) + 2 = 1026
  assert.equal(visualTokensFor(1024, 1024), 1026)
  // Capped at the default 1280.
  assert.equal(visualTokensFor(4096, 4096), 1280)
  // The documented high-resolution cap is inclusive.
  assert.equal(visualTokensFor(4096, 4096, { highResolution: true }), 16384)
})

await test('builds a native request with the documented envelope', () => {
  const built = dashscopeNative.buildRequest({
    route,
    apiKey: 'sk-test',
    stream: true,
    options: {
      provider: 'bailian-native',
      model: 'qwen3.8-max',
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'lookup', description: 'look up', parameters: { type: 'object' } }],
      maxTokens: 64,
      temperature: 0.2,
    },
  })
  const body = JSON.parse(built.body)
  assert.equal(built.url, 'https://example.invalid/api/v1/services/aigc/multimodal-generation/generation')
  assert.equal(built.headers['x-dashscope-sse'], 'enable')
  assert.equal(built.headers.authorization, 'Bearer sk-test')
  assert.equal(body.input.messages[0].role, 'system')
  assert.equal(body.input.messages[1].content, 'hi')
  assert.equal(body.parameters.result_format, 'message')
  assert.equal(body.parameters.incremental_output, true)
  assert.equal(body.parameters.max_completion_tokens, 64)
  assert.equal(body.parameters.tools[0].function.name, 'lookup')
  assert.equal(body.parameters.tool_choice, 'auto')
})

await test('rejects a non-streaming thinking request locally', () => {
  assert.throws(
    () => dashscopeNative.buildRequest({
      route,
      apiKey: 'sk-test',
      stream: false,
      options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], reasoningEffort: 'high' },
    }),
    (error) => error.code === 'INVALID_REQUEST' && /streaming/.test(error.message),
  )
})

await test('sends enable_thinking and a budget when an effort is requested', () => {
  const withBudgets = { ...route, models: [{ ...route.models[0], thinkingBudgets: { high: 8192 } }] }
  const built = dashscopeNative.buildRequest({
    route: withBudgets,
    apiKey: 'sk-test',
    stream: true,
    options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], reasoningEffort: 'high' },
  })
  const body = JSON.parse(built.body)
  assert.equal(body.parameters.enable_thinking, true)
  assert.equal(body.parameters.thinking_budget, 8192)
})

await test('turns thinking off explicitly when the effort is off', () => {
  const built = dashscopeNative.buildRequest({
    route,
    apiKey: 'sk-test',
    stream: true,
    options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], reasoningEffort: 'off' },
  })
  assert.equal(JSON.parse(built.body).parameters.enable_thinking, false)
})

await test('translates incremental native frames into token deltas', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ output: { choices: [{ message: { content: 'I am', role: 'assistant' }, finish_reason: 'null' }] }, usage: { total_tokens: 27, output_tokens: 1, input_tokens: 26, prompt_tokens_details: { cached_tokens: 0 } }, request_id: 'r1' }, 1),
      frame({ output: { choices: [{ message: { content: ' fine', role: 'assistant' }, finish_reason: 'null' }] }, usage: { total_tokens: 30, output_tokens: 4, input_tokens: 26 } }, 2),
      frame({ output: { choices: [{ message: { content: '', role: 'assistant' }, finish_reason: 'stop' }] }, usage: { total_tokens: 92, output_tokens: 66, input_tokens: 26, prompt_tokens_details: { cached_tokens: 0 } } }, 3),
    ]),
  }))
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['block-start', 'text-delta', 'text-delta', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'I am')
  assert.equal(chunks[2].text, ' fine')
  assert.equal(chunks[3].usage.outputTokens, 66)
  assert.deepEqual(chunks[4].reason, { kind: 'stop' })
})

await test('reconstructs deltas when the provider ignores incremental_output', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ output: { choices: [{ message: { content: 'I love' }, finish_reason: 'null' }] } }, 1),
      frame({ output: { choices: [{ message: { content: 'I love eating' }, finish_reason: 'null' }] } }, 2),
      frame({ output: { choices: [{ message: { content: 'I love eating apples' }, finish_reason: 'stop' }] } }, 3),
    ]),
  }))
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
  assert.equal(text, 'I love eating apples')
})

await test('reads reasoning_content into a reasoning block', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ output: { choices: [{ message: { content: '', reasoning_content: 'Hmm', role: 'assistant' }, finish_reason: 'null' }] } }, 1),
      frame({ output: { choices: [{ message: { content: 'Answer', reasoning_content: '' }, finish_reason: 'stop' }] } }, 2),
    ]),
  }))
  assert.equal(chunks[0].blockType, 'reasoning')
  assert.equal(chunks[1].type, 'reasoning-delta')
  assert.equal(chunks[1].text, 'Hmm')
  const textIndex = chunks.find((chunk) => chunk.type === 'text-delta').index
  assert.equal(textIndex, 1)
})

await test('tolerates a gateway that appends a [DONE] sentinel', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ output: { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] } }, 1),
      'data:[DONE]\n\n',
    ]),
  }))
  assert.equal(chunks.filter((chunk) => chunk.type === 'finish').length, 1)
})

await test('emits exactly one terminal finish on an error frame', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded, please try again later.', request_id: 'r9' }, 1),
    ]),
  }))
  const finishes = chunks.filter((chunk) => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(finishes[0].reason.kind, 'error')
  assert.equal(finishes[0].reason.failure.code, 'RATE_LIMIT')
})

await test('reports a closed stream with no frames', async () => {
  const chunks = await collect(translateNativeStream({ route, adapter: dashscopeNative, body: sseBody([]) }))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].reason.failure.code, 'STREAM_CLOSED')
})

await test('maps the documented error codes onto stable failures', () => {
  const cases = [
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'AUTH'],
    [401, { code: 'invalid_api_key' }, 'AUTH'],
    [401, { code: 'NOT AUTHORIZED' }, 'AUTH'],
    [429, { code: 'Throttling.RateQuota' }, 'RATE_LIMIT'],
    [400, { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }, 'QUOTA'],
    [403, { code: 'AllocationQuota.FreeTierOnly' }, 'QUOTA'],
    [400, { code: 'InternalError.Algo.InvalidParameter', message: 'Range of input length should be [1, 1000]' }, 'CONTEXT_WINDOW_EXCEEDED'],
    [400, { code: 'DataInspectionFailed' }, 'INVALID_REQUEST'],
    [400, { code: 'BadRequest.EmptyModel' }, 'INVALID_REQUEST'],
    [400, { message: 'Model not exist.' }, 'INVALID_REQUEST'],
    [500, { code: 'InternalError' }, 'SERVER'],
    [503, {}, 'SERVER'],
    [418, {}, 'HTTP_418'],
  ]
  for (const [status, payload, expected] of cases) {
    const mapped = dashscopeNative.mapError(status, payload, new Headers())
    assert.equal(mapped.code, expected, `status ${status} payload ${JSON.stringify(payload)} -> ${mapped.code}, expected ${expected}`)
  }
})

await test('surfaces Retry-After in milliseconds', () => {
  const mapped = dashscopeNative.mapError(429, { code: 'Throttling.RateQuota' }, new Headers({ 'retry-after': '2' }))
  assert.equal(mapped.providerRetryAfterMs, 2000)
})

await test('converts a transport failure into a terminal finish chunk', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }) }
  try {
    const chunks = await collect(runNativeRequest({
      adapter: dashscopeNative,
      route,
      apiKey: 'sk-test',
      stream: true,
      options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].reason.kind, 'error')
    assert.equal(chunks[0].reason.failure.code, 'TRANSPORT')
  } finally {
    globalThis.fetch = original
  }
})

await test('fails a credential-less request as MISSING_CREDENTIAL before any I/O', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('must not be reached') }
  try {
    const chunks = await collect(runNativeRequest({
      adapter: dashscopeNative,
      route,
      apiKey: undefined,
      stream: true,
      options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    }))
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].reason.failure.code, 'MISSING_CREDENTIAL')
    assert.equal(called, false, 'no provider request may be sent without a credential')
  } finally {
    globalThis.fetch = original
  }
})

await test('turns a non-2xx response into a mapped terminal failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'bad key', request_id: 'r7' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const chunks = await collect(runNativeRequest({
      adapter: dashscopeNative,
      route,
      apiKey: 'sk-test',
      stream: true,
      options: { provider: 'bailian-native', model: 'qwen3.8-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    }))
    assert.equal(chunks[0].reason.failure.code, 'AUTH')
    assert.equal(chunks[0].reason.failure.requestId, 'r7')
  } finally {
    globalThis.fetch = original
  }
})

await test('reads the multimodal content array and image_tokens', () => {
  const parsed = dashscopeNative.parseReply({
    output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ text: 'a cat' }] } }] },
    usage: { output_tokens: 55, input_tokens: 1271, image_tokens: 1247 },
    request_id: 'ccf845a3',
  })
  assert.equal(parsed.text, 'a cat')
  assert.equal(parsed.usage.inputTokens, 2518)
  assert.equal(parsed.usage.outputTokens, 55)
  assert.equal(parsed.requestId, 'ccf845a3')
})

await test('carries tool calls as JSON argument strings', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([
      frame({ output: { choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' }, index: 0 }] }, finish_reason: 'tool_calls' }] } }, 1),
    ]),
  }))
  const delta = chunks.find((chunk) => chunk.type === 'tool-call-delta')
  assert.equal(delta.id, 'call_1')
  assert.equal(delta.name, 'lookup')
  assert.equal(delta.argumentsDelta, '{"q":"x"}')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

await test('treats an empty successful turn as a retryable empty response', async () => {
  const chunks = await collect(translateNativeStream({
    route,
    adapter: dashscopeNative,
    body: sseBody([frame({ output: { choices: [{ message: { content: '' }, finish_reason: 'stop' }] } }, 1)]),
  }))
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
