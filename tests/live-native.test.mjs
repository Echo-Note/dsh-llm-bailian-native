/**
 * Live end-to-end check of the native DashScope wire layer.
 *
 * Not part of the offline suite: it performs real provider requests. Run with a
 * credential in the environment (never on the command line):
 *
 *   DASHSCOPE_API_KEY=... node tests/live-native.test.mjs [baseURL] [model]
 *
 * @module @local/dsh-llm-bailian-native/tests/live-native
 */

import { protocolFor } from '../lib/providers/index.js'
import { runNativeRequest } from '../lib/stream.js'
import { resolveRoute } from '../lib/config.js'

const apiKey = process.env.DASHSCOPE_API_KEY
const baseURL = process.argv[2] ?? 'https://llm-t0jjkadn2cznoq4n.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
const model = process.argv[3] ?? 'qwen3.8-flash'

if (typeof apiKey !== 'string' || apiKey.length === 0) {
  console.error('set DASHSCOPE_API_KEY in the environment first')
  process.exit(2)
}

const adapter = protocolFor('dashscope-native')
const route = resolveRoute('bailian-native', {
  protocol: 'dashscope-native',
  baseURL,                       // includes /compatible-mode/v1 on purpose: the normalizer must strip it
  apiKeyEnv: 'DASHSCOPE_API_KEY',
  modelDisabled: [],
})

console.log(`baseURL   : ${route.baseURL}`)
console.log(`path used : ${adapter.generationPathFor(route, model).path} (${adapter.generationPathFor(route, model).reason})`)
console.log(`model     : ${model}\n`)

/** @param {AsyncIterable<any>} chunks */
async function drain(chunks) {
  const types = []
  let text = ''
  let usage = null
  let finish = null
  for await (const chunk of chunks) {
    types.push(chunk.type)
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  return { types, text, usage, finish }
}

// --- 1. a real streaming request -----------------------------------------
console.log('--- streaming request ---')
const ok = await drain(runNativeRequest({
  adapter,
  route,
  apiKey,
  stream: true,
  options: {
    provider: 'bailian-native',
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: PONG' }] }],
    maxTokens: 32,
  },
}))
console.log('chunk types :', [...new Set(ok.types)].join(', '))
console.log('deltas      :', ok.types.filter((t) => t === 'text-delta').length)
console.log('text        :', JSON.stringify(ok.text.slice(0, 120)))
console.log('usage       :', JSON.stringify(ok.usage))
console.log('finish      :', JSON.stringify(ok.finish))
const finishes = ok.types.filter((t) => t === 'finish').length
console.log('CHECKS      : one-finish=' + (finishes === 1) + ' usage-before-finish=' + (ok.types.indexOf('usage') < ok.types.indexOf('finish')) + ' has-text=' + (ok.text.length > 0))

// --- 2. a predictable failure: invalid key ------------------------------
console.log('\n--- failure mapping: invalid key ---')
const bad = await drain(runNativeRequest({
  adapter,
  route,
  apiKey: 'sk-definitely-not-a-valid-key',
  stream: true,
  options: { provider: 'bailian-native', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8 },
}))
console.log('finish      :', JSON.stringify(bad.finish))
console.log('code        :', bad.finish?.failure?.code)

// --- 3. a predictable failure: no credential ----------------------------
console.log('\n--- failure mapping: missing credential ---')
const missing = await drain(runNativeRequest({
  adapter,
  route,
  apiKey: undefined,
  stream: true,
  options: { provider: 'bailian-native', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 8 },
}))
console.log('finish      :', JSON.stringify(missing.finish))

// --- 4. the model catalog ------------------------------------------------
console.log('\n--- native model catalog (GET /api/v1/models) ---')
const catalog = await adapter.listEndpointModels({ route, apiKey, maxPages: 1, pageSize: 10 })
console.log('supported   :', catalog.supported)
console.log('notice      :', catalog.notice ?? '(none)')
console.log('models      :', (catalog.models ?? []).slice(0, 10).map((m) => `${m.id}${m.inputModalities ? ` [${m.inputModalities.join('+')}]` : ''}`).join(', ') || '(none)')
