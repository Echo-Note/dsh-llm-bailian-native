/**
 * Offline checks for the Aliyun ModelStudio billing client.
 *
 * No network and no credential: every assertion is about the signature
 * construction documented in the Model Studio "ROA风格请求体&签名机制" page and
 * about the response mapping.
 *
 * Run with: `node tests/billing.test.mjs`
 *
 * @module @local/dsh-llm-bailian-native/tests/billing
 */

import assert from 'node:assert/strict'

import {
  API_VERSION,
  EMPTY_PAYLOAD_SHA256,
  DIMENSIONS,
  canonicalQueryString,
  gatewayHost,
  getBillingOverview,
  getBillingTrend,
  percentEncode,
  sha256Hex,
  signRequest,
} from '../lib/billing.js'

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

const base = {
  accessKeyId: 'TESTAK',
  accessKeySecret: 'TESTSK',
  action: 'GetBillingOverview',
  path: '/modelstudio/billing/overview',
  host: 'modelstudio.cn-beijing.aliyuncs.com',
  date: '2026-10-12T09:00:00Z',
  nonce: 'fixed-nonce',
}

process.stdout.write('billing client\n')

await test('percent-encodes per RFC3986, not per URLSearchParams', () => {
  assert.equal(percentEncode('a b'), 'a%20b', 'space must be %20, never +')
  assert.equal(percentEncode('a*b'), 'a%2Ab', '* must be encoded')
  assert.equal(percentEncode('a~b'), 'a~b', '~ must stay literal')
  assert.equal(percentEncode("a'b"), 'a%27b')
  assert.equal(percentEncode('qwen-plus/2026'), 'qwen-plus%2F2026')
})

await test('sorts the canonical query string by encoded name then value', () => {
  assert.equal(
    canonicalQueryString({ topNum: '20', billMonth: '2026-08', RegionId: 'cn-beijing' }),
    'RegionId=cn-beijing&billMonth=2026-08&topNum=20',
  )
  assert.equal(canonicalQueryString({ b: ['2', '1'], a: 'x' }), 'a=x&b=1&b=2')
  assert.equal(canonicalQueryString({ a: undefined, b: null, c: '' }), '', 'absent values are dropped')
})

await test('a body-less GET hashes to the documented empty payload', () => {
  assert.equal(sha256Hex(''), EMPTY_PAYLOAD_SHA256)
})

await test('builds the documented canonical request', () => {
  const signed = signRequest({ ...base, query: { billMonth: '2026-08', 'groupBy.1.code': 'BASE_MODEL' } })
  const lines = signed.canonicalRequest.split('\n')
  assert.equal(lines[0], 'GET')
  assert.equal(lines[1], '/modelstudio/billing/overview')
  assert.equal(lines[2], 'billMonth=2026-08&groupBy.1.code=BASE_MODEL')
  assert.equal(lines[3], 'host:modelstudio.cn-beijing.aliyuncs.com')
  assert.equal(lines[4], `x-acs-action:GetBillingOverview`)
  assert.equal(lines[5], `x-acs-content-sha256:${EMPTY_PAYLOAD_SHA256}`)
  assert.equal(lines[6], 'x-acs-date:2026-10-12T09:00:00Z')
  assert.equal(lines[7], 'x-acs-signature-nonce:fixed-nonce')
  assert.equal(lines[8], `x-acs-version:${API_VERSION}`)
  assert.equal(lines[9], '')
  assert.equal(
    lines[10],
    'host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version',
  )
  assert.equal(lines[11], EMPTY_PAYLOAD_SHA256)
})

await test('signs the canonical request with ACS3-HMAC-SHA256', () => {
  const signed = signRequest({ ...base, query: { billMonth: '2026-08' } })
  assert.match(signed.stringToSign, /^ACS3-HMAC-SHA256\n[0-9a-f]{64}$/)
  assert.match(
    signed.headers.authorization,
    /^ACS3-HMAC-SHA256 Credential=TESTAK,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=[0-9a-f]{64}$/,
  )
  // Deterministic for fixed date and nonce, which is what makes it testable.
  const again = signRequest({ ...base, query: { billMonth: '2026-08' } })
  assert.equal(again.headers.authorization, signed.headers.authorization)
})

await test('signs every public header it sends, and content-type only when there is a body', () => {
  const noBody = signRequest(base)
  assert.ok(!Object.keys(noBody.headers).includes('content-type'))
  const withBody = signRequest({ ...base, body: '{"a":1}' })
  assert.equal(withBody.headers['content-type'], 'application/json; charset=utf-8')
  assert.match(withBody.headers.authorization, /SignedHeaders=.*content-type/)
  assert.equal(withBody.headers['x-acs-content-sha256'], sha256Hex('{"a":1}'))
})

await test('refuses a blank credential instead of sending an anonymous request', () => {
  assert.throws(() => signRequest({ ...base, accessKeyId: '' }), (error) => error.code === 'INVALID_CREDENTIAL')
  assert.throws(() => signRequest({ ...base, accessKeySecret: '' }), (error) => error.code === 'INVALID_CREDENTIAL')
})

await test('uses the documented product gateway, per region', () => {
  assert.equal(gatewayHost(), 'modelstudio.cn-beijing.aliyuncs.com')
  assert.equal(gatewayHost('ap-southeast-1'), 'modelstudio.ap-southeast-1.aliyuncs.com')
})

await test('exposes the documented dimension codes', () => {
  assert.deepEqual([...DIMENSIONS].sort(), [
    'API_KEY_ID', 'ARTICLE_CODE', 'BASE_MODEL', 'BUSINESS_REGION', 'CHARGE_TYPE',
    'FEE_TYPE', 'MAAS_TYPE', 'SERVICE_SITE', 'WORKSPACE_ID',
  ])
})

await test('rejects a malformed month or range before signing', async () => {
  const overview = await getBillingOverview({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, billMonth: '2026/08' })
  assert.equal(overview.ok, false)
  assert.equal(overview.code, 'INVALID_REQUEST')
  const trend = await getBillingTrend({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, granularity: 'WEEK', start: '2026-08-01', end: '2026-08-31' })
  assert.equal(trend.ok, false)
  assert.equal(trend.code, 'INVALID_REQUEST')
})

await test('sends groupBy and filter as JSON strings in the query (verified live)', async () => {
  // Measured: raw JSON 400s with `Telemetry.InvalidParams: groupBy required`,
  // the indexed `groupBy.1.code` form does too, and a POST body answers
  // `InvalidAction.NotFound`. The JSON-string form answers 200.
  const original = globalThis.fetch
  /** @type {string | undefined} */
  let seen
  globalThis.fetch = async (url) => {
    seen = String(url)
    return new Response(JSON.stringify({ requestId: 'r', code: '200', success: true, data: { currency: 'CNY', totalAmount: '1', pretaxAmount: '1', taxAmount: '0', groups: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await getBillingOverview({
      credentials: { accessKeyId: 'a', accessKeySecret: 'b' },
      billMonth: '2026-08',
      groupBy: 'BASE_MODEL',
      filters: [{ code: 'WORKSPACE_ID', values: ['llm-x'], selectType: 'IN' }],
    })
    const decoded = decodeURIComponent(seen ?? '')
    assert.match(decoded, /groupBy=\[\{"code":"BASE_MODEL"\}\]/, 'groupBy must be a JSON array string')
    assert.match(decoded, /filter=\{"dimensions":\[\{"code":"WORKSPACE_ID","values":\["llm-x"\],"selectType":"IN"\}\]\}/)
    assert.ok(!/groupBy\.1\.code/.test(decoded), 'the indexed form must not be used')
  } finally {
    globalThis.fetch = original
  }
})

await test('sends timePeriod as a JSON object string for the trend', async () => {
  const original = globalThis.fetch
  /** @type {string | undefined} */
  let seen
  globalThis.fetch = async (url) => {
    seen = String(url)
    return new Response(JSON.stringify({ code: '200', success: true, data: { costTotals: {}, groupByTotal: [], resultByTime: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await getBillingTrend({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, granularity: 'DAY', start: '2026-09-01', end: '2026-09-30', groupBy: 'BASE_MODEL' })
    const decoded = decodeURIComponent(seen ?? '')
    assert.match(decoded, /timePeriod=\{"start":"2026-09-01","end":"2026-09-30"\}/)
    assert.match(decoded, /granularity=DAY/)
  } finally {
    globalThis.fetch = original
  }
})

await test('maps gateway error codes onto stable failures', async () => {
  const original = globalThis.fetch
  const cases = [
    [{ Code: 'SignatureDoesNotMatch', Message: 'Specified signature does not match our calculation.' }, 400, 'INVALID_CREDENTIAL'],
    [{ Code: 'InvalidAccessKeyId.NotFound', Message: 'Specified access key is not found.' }, 404, 'MISSING_CREDENTIAL'],
    [{ Code: 'Forbidden', Message: 'no permission' }, 403, 'AUTH'],
    [{ Code: 'Throttling.User', Message: 'too fast' }, 429, 'RATE_LIMIT'],
    [{ Code: 'InternalError', Message: 'oops' }, 500, 'SERVER'],
  ]
  try {
    for (const [body, status, expected] of cases) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      const result = await getBillingOverview({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, billMonth: '2026-08' })
      assert.equal(result.ok, false)
      assert.equal(result.code, expected, `${body.Code} -> ${result.code}, expected ${expected}`)
    }
    // A 200 that reports failure must not be treated as success.
    globalThis.fetch = async () => new Response(JSON.stringify({ code: '500', success: false, message: 'bad' }), { status: 200, headers: { 'content-type': 'application/json' } })
    const failed = await getBillingOverview({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, billMonth: '2026-08' })
    assert.equal(failed.ok, false)
  } finally {
    globalThis.fetch = original
  }
})

await test('parses an overview response into the documented shape', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    requestId: 'BB521414',
    code: '200',
    success: true,
    data: {
      currency: 'CNY',
      totalAmount: '31228.60',
      pretaxAmount: '28729.32',
      taxAmount: '2499.28',
      groups: [{ key: 'qwen-plus', name: 'qwen-plus', articleCodes: ['sfm_x'], amount: '3000', percentage: '0.10' }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const result = await getBillingOverview({ credentials: { accessKeyId: 'a', accessKeySecret: 'b' }, billMonth: '2026-08', groupBy: 'BASE_MODEL' })
    assert.equal(result.ok, true)
    assert.equal(result.currency, 'CNY')
    assert.equal(result.totalAmount, '31228.60')
    assert.equal(result.groups[0].key, 'qwen-plus')
    assert.equal(result.groups[0].percentage, '0.10')
    assert.equal(result.requestId, 'BB521414')
  } finally {
    globalThis.fetch = original
  }
})

await test('parses a trend response, keeping period and per-group detail', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: '200',
    success: true,
    data: {
      costTotals: { amount: '100', pretaxAmount: '94.34', taxAmount: '5.66', currency: 'CNY' },
      groupByTotal: [{ key: 'qwen-plus', name: 'qwen-plus', amount: '60', pretaxAmount: '56.60', taxAmount: '3.40' }],
      resultByTime: [{
        period: '20260801',
        total: { amount: '30', pretaxAmount: '28.30', taxAmount: '1.70', currency: 'CNY' },
        periodDetails: [{ key: 'qwen-plus', name: 'qwen-plus', amount: '20', pretaxAmount: '18.87', taxAmount: '1.13', percentage: '0.6667' }],
      }],
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const result = await getBillingTrend({
      credentials: { accessKeyId: 'a', accessKeySecret: 'b' },
      granularity: 'DAY',
      start: '2026-08-01',
      end: '2026-08-31',
      groupBy: 'BASE_MODEL',
    })
    assert.equal(result.ok, true)
    assert.equal(result.costTotals.currency, 'CNY')
    assert.equal(result.groupByTotal[0].key, 'qwen-plus')
    assert.equal(result.resultByTime[0].period, '20260801')
    assert.equal(result.resultByTime[0].total.amount, '30')
    assert.equal(result.resultByTime[0].periodDetails[0].percentage, '0.6667')
  } finally {
    globalThis.fetch = original
  }
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
