/**
 * Aliyun `ModelStudio` OpenAPI (version 2026-02-10) billing client.
 *
 * This is the **second leg** of the plugin's cost story. Local token metering
 * answers "what did this call cost"; these operations answer "what was actually
 * charged". They are reconciled on the `BASE_MODEL` dimension.
 *
 * ## Why this is a separate credential
 *
 * These are Aliyun gateway APIs signed with **AccessKey ID/Secret**, not the
 * Bailian `sk-…` model key. A model key can call models; it cannot query money.
 * The plugin therefore takes two credential *references* (never values).
 *
 * ## Signature
 *
 * `ACS3-HMAC-SHA256` (V3), implemented from the Model Studio documentation
 * "ROA风格请求体&签名机制":
 * https://help.aliyun.com/zh/model-studio/roa-style-request-body-signature-mechanism
 *
 *   CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQueryString \n
 *                      CanonicalHeaders \n SignedHeaders \n HashedRequestPayload
 *   StringToSign     = "ACS3-HMAC-SHA256" \n HexEncode(SHA256(CanonicalRequest))
 *   Signature        = HexEncode(HMAC-SHA256(secret, StringToSign))
 *   Authorization    = ACS3-HMAC-SHA256 Credential=<AK>,SignedHeaders=<...>,Signature=<...>
 *
 * Signed headers are every `x-acs-*` header present, plus `host` and
 * `content-type`, lower-cased, sorted, values trimmed. Query parameters are
 * RFC3986-encoded and sorted by name.
 *
 * Operations (documented, Last Updated Oct 11 2026):
 *   GET /modelstudio/billing/overview  — GetBillingOverview
 *     required: billMonth (YYYY-MM), groupBy[].code (exactly one)
 *   GET /modelstudio/billing/trend     — GetBillingTrend
 *     required: granularity (DAY|MONTH), timePeriod.start/end (YYYY-MM-DD), groupBy[].code
 *
 * @module @local/dsh-llm-bailian-native/billing
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

import { FAILURE_CODES, failure } from './protocol.js'

/** OpenAPI product coordinates, both from the doc URLs. */
export const API_VERSION = '2026-02-10'
export const BILLING_OVERVIEW_ACTION = 'GetBillingOverview'
export const BILLING_TREND_ACTION = 'GetBillingTrend'
export const OVERVIEW_PATH = '/modelstudio/billing/overview'
export const TREND_PATH = '/modelstudio/billing/trend'

/** Signature protocol; the docs state MD5/SHA1 are no longer accepted. */
export const SIGNATURE_ALGORITHM = 'ACS3-HMAC-SHA256'

/** SHA-256 of an empty body, used verbatim for a body-less GET. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Grouping / filtering dimensions both operations accept. */
export const DIMENSIONS = Object.freeze([
  'MAAS_TYPE',
  'BASE_MODEL',
  'API_KEY_ID',
  'WORKSPACE_ID',
  'FEE_TYPE',
  'CHARGE_TYPE',
  'BUSINESS_REGION',
  'SERVICE_SITE',
  'ARTICLE_CODE',
])

/**
 * Gateway host for a region.
 *
 * The docs give the path and `regionId` but do not print the host, so the
 * standard Aliyun product-gateway form is used and the host is configurable:
 * a deployment whose console shows a different API host can override it without
 * touching this file. Confirming the exact host needs one real call.
 * @param {string} regionId
 */
export function gatewayHost(regionId = 'cn-beijing') {
  return `modelstudio.${regionId}.aliyuncs.com`
}

/**
 * RFC3986 percent-encoding, matching the documented rules exactly: unreserved
 * characters stay literal, space becomes `%20` (never `+`), `*` becomes `%2A`,
 * and `~` is never turned into `%7E`.
 * @param {string} value
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%7E/g, '~')
}

/** @param {string} input */
export function sha256Hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** @param {string} secret @param {string} stringToSign */
export function hmacSha256Hex(secret, stringToSign) {
  return createHmac('sha256', secret).update(stringToSign, 'utf8').digest('hex')
}

/**
 * Build the canonical query string: names and values RFC3986-encoded, pairs
 * sorted by name then value, joined with `&`. `undefined` and `null` are
 * dropped; a parameter with no value is `name=`.
 * @param {Record<string, unknown>} parameters
 */
export function canonicalQueryString(parameters) {
  const pairs = []
  for (const [name, raw] of Object.entries(parameters)) {
    if (raw === undefined || raw === null || raw === '') continue
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (entry === undefined || entry === null) continue
        pairs.push([percentEncode(name), percentEncode(String(entry))])
      }
      continue
    }
    pairs.push([percentEncode(name), percentEncode(String(raw))])
  }
  pairs.sort((left, right) => (left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1))
  return pairs.map(([name, value]) => `${name}=${value}`).join('&')
}

/**
 * Sign one request and return the ready-to-send headers.
 *
 * Exported so the signing can be asserted against the documented example shapes
 * without any network access.
 *
 * @param {object} input
 * @param {string} input.accessKeyId
 * @param {string} input.accessKeySecret
 * @param {string} input.action      e.g. GetBillingOverview
 * @param {string} input.path        e.g. /modelstudio/billing/overview
 * @param {string} input.host
 * @param {Record<string, unknown>} [input.query]
 * @param {string} [input.body]      JSON body; omitted for a GET
 * @param {string} [input.date]      x-acs-date; defaults to now (ISO8601 UTC)
 * @param {string} [input.nonce]
 * @returns {{ url: string, headers: Record<string, string>, canonicalRequest: string, stringToSign: string }}
 */
export function signRequest({ accessKeyId, accessKeySecret, action, path, host, query = {}, body, date, nonce }) {
  if (typeof accessKeyId !== 'string' || accessKeyId.length === 0) throw failure(FAILURE_CODES.INVALID_CREDENTIAL, 'the AccessKey ID is blank')
  if (typeof accessKeySecret !== 'string' || accessKeySecret.length === 0) throw failure(FAILURE_CODES.INVALID_CREDENTIAL, 'the AccessKey secret is blank')

  const payload = body ?? ''
  const hashedPayload = sha256Hex(payload)
  const queryString = canonicalQueryString(query)

  /** @type {Record<string, string>} */
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-version': API_VERSION,
    'x-acs-date': date ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    'x-acs-signature-nonce': nonce ?? randomUUID(),
    'x-acs-content-sha256': hashedPayload,
  }
  if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'

  // CanonicalHeaders: only x-acs-*, host and content-type participate.
  const signedNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .filter((name) => name.startsWith('x-acs-') || name === 'host' || name === 'content-type')
    .sort()
  const canonicalHeaders = signedNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const signedHeaders = signedNames.join(';')

  const canonicalRequest = [
    'GET',
    path,
    queryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join('\n')

  const stringToSign = `${SIGNATURE_ALGORITHM}\n${sha256Hex(canonicalRequest)}`
  const signature = hmacSha256Hex(accessKeySecret, stringToSign)

  const url = `https://${host}${path}${queryString.length > 0 ? `?${queryString}` : ''}`
  return {
    url,
    headers: {
      ...headers,
      authorization: `${SIGNATURE_ALGORITHM} Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
  }
}

/**
 * Query the billing overview for one month.
 *
 * @param {object} input
 * @param {{ accessKeyId: string, accessKeySecret: string, regionId?: string, host?: string, locale?: string, signal?: AbortSignal }} input.credentials
 * @param {string} input.billMonth            YYYY-MM
 * @param {string} [input.groupBy]            one dimension code, default MAAS_TYPE
 * @param {Array<{ code: string, values: string[], selectType?: 'IN' | 'NOT' }>} [input.filters]
 * @param {number} [input.topNum]             1..20
 * @returns {Promise<{ ok: true, currency: string, totalAmount: string, pretaxAmount: string, taxAmount: string, groups: Array<{ key: string, name: string, articleCodes: string[], amount: string, percentage: string }>, requestId?: string } | { ok: false, code: string, message: string, status?: number }>}
 */
export async function getBillingOverview({ credentials, billMonth, groupBy = 'MAAS_TYPE', filters = [], topNum = 20 }) {
  if (typeof billMonth !== 'string' || !/^\d{4}-\d{2}$/.test(billMonth)) {
    return { ok: false, code: FAILURE_CODES.INVALID_REQUEST, message: 'billMonth must be YYYY-MM' }
  }
  const query = {
    billMonth,
    groupBy: JSON.stringify([{ code: groupBy }]),
    topNum: String(Math.min(20, Math.max(1, Math.floor(topNum) || 20))),
  }
  applyFilters(query, filters)
  return await callBilling({ credentials, action: BILLING_OVERVIEW_ACTION, path: OVERVIEW_PATH, query, parse: parseOverview })
}

/**
 * Query the billing trend over a date range.
 *
 * @param {object} input
 * @param {{ accessKeyId: string, accessKeySecret: string, regionId?: string, host?: string, locale?: string, signal?: AbortSignal }} input.credentials
 * @param {'DAY' | 'MONTH'} input.granularity
 * @param {string} input.start                YYYY-MM-DD
 * @param {string} input.end                  YYYY-MM-DD
 * @param {string} [input.groupBy]
 * @param {Array<{ code: string, values: string[], selectType?: 'IN' | 'NOT' }>} [input.filters]
 * @param {number} [input.topNum]
 * @returns {Promise<{ ok: true, costTotals: any, groupByTotal: any[], resultByTime: any[], requestId?: string } | { ok: false, code: string, message: string, status?: number }>}
 */
export async function getBillingTrend({ credentials, granularity, start, end, groupBy = 'MAAS_TYPE', filters = [], topNum = 20 }) {
  if (granularity !== 'DAY' && granularity !== 'MONTH') {
    return { ok: false, code: FAILURE_CODES.INVALID_REQUEST, message: 'granularity must be DAY or MONTH' }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return { ok: false, code: FAILURE_CODES.INVALID_REQUEST, message: 'start and end must be YYYY-MM-DD' }
  }
  const query = {
    granularity,
    // Same wire rule as `groupBy`: object parameters travel as JSON strings.
    timePeriod: JSON.stringify({ start, end }),
    groupBy: JSON.stringify([{ code: groupBy }]),
    topNum: String(Math.min(20, Math.max(1, Math.floor(topNum) || 20))),
  }
  applyFilters(query, filters)
  return await callBilling({ credentials, action: BILLING_TREND_ACTION, path: TREND_PATH, query, parse: parseTrend })
}

/**
 * Attach `filter` as a JSON object string, the same way `groupBy` travels.
 *
 * Measured on 2026-10-12: this API is GET-only and reads its array/object
 * parameters from the query string as **JSON strings**. Sending the raw JSON
 * (`groupBy=[{"code":"BASE_MODEL"}]`) or the indexed form (`groupBy.1.code=…`)
 * both answer `Telemetry.InvalidParams: groupBy required`; the JSON-string form
 * answers 200. A POST body is rejected outright (`InvalidAction.NotFound`).
 *
 * @param {Record<string, string>} query
 * @param {Array<{ code: string, values: string[], selectType?: string }>} filters
 */
function applyFilters(query, filters) {
  const dimensions = []
  for (const filter of filters ?? []) {
    if (filter === null || typeof filter !== 'object') continue
    if (typeof filter.code !== 'string' || filter.code.length === 0) continue
    if (!Array.isArray(filter.values) || filter.values.length === 0) continue
    dimensions.push({
      code: filter.code,
      values: filter.values.map(String),
      ...(filter.selectType === 'IN' || filter.selectType === 'NOT' ? { selectType: filter.selectType } : {}),
    })
  }
  if (dimensions.length > 0) query.filter = JSON.stringify({ dimensions })
}

/** @param {object} input */
async function callBilling({ credentials, action, path, query, parse }) {
  const regionId = credentials.regionId ?? 'cn-beijing'
  const host = credentials.host ?? gatewayHost(regionId)
  const signed = signRequest({
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    action,
    path,
    host,
    query: { RegionId: regionId, ...query },
  })
  let response
  try {
    response = await fetch(signed.url, {
      method: 'GET',
      headers: signed.headers,
      ...(credentials.signal === undefined ? {} : { signal: credentials.signal }),
    })
  } catch (error) {
    return { ok: false, code: FAILURE_CODES.TRANSPORT, message: `could not reach ${host}: ${error instanceof Error ? error.message : String(error)}` }
  }
  const payload = await response.json().catch(() => undefined)
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  if (!response.ok) {
    const code = typeof body.Code === 'string' ? body.Code : typeof body.code === 'string' ? body.code : undefined
    return {
      ok: false,
      code: mapGatewayCode(code, response.status),
      message: `${code ?? `HTTP ${response.status}`}: ${body.Message ?? body.message ?? 'the billing API rejected the request'}`,
      status: response.status,
    }
  }
  const success = body.success === true || body.Success === true || body.code === '200' || body.Code === '200'
  if (!success) {
    const code = typeof body.code === 'string' ? body.code : typeof body.Code === 'string' ? body.Code : undefined
    return { ok: false, code: mapGatewayCode(code, response.status), message: body.message ?? body.Message ?? 'the billing API reported failure', status: response.status }
  }
  const data = body.data ?? body.Data ?? {}
  return { ok: true, ...parse(data), ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}) }
}

/** @param {string | undefined} code @param {number} status */
function mapGatewayCode(code, status) {
  if (code === 'SignatureDoesNotMatch' || code === 'IncompleteSignature') return FAILURE_CODES.INVALID_CREDENTIAL
  if (code === 'InvalidAccessKeyId.NotFound' || code === 'InvalidAccessKeyId') return FAILURE_CODES.MISSING_CREDENTIAL
  if (code === 'Forbidden' || code === 'NoPermission' || code === 'Unauthorized') return FAILURE_CODES.AUTH
  if (code === 'Throttling' || code === 'Throttling.User') return FAILURE_CODES.RATE_LIMIT
  if (status >= 500) return FAILURE_CODES.SERVER
  return FAILURE_CODES.INVALID_REQUEST
}

/** @param {any} data */
function parseOverview(data) {
  return {
    currency: String(data.currency ?? ''),
    totalAmount: String(data.totalAmount ?? '0'),
    pretaxAmount: String(data.pretaxAmount ?? '0'),
    taxAmount: String(data.taxAmount ?? '0'),
    groups: Array.isArray(data.groups)
      ? data.groups.map((group) => ({
          key: String(group?.key ?? ''),
          name: String(group?.name ?? ''),
          articleCodes: Array.isArray(group?.articleCodes) ? group.articleCodes.map(String) : [],
          amount: String(group?.amount ?? '0'),
          percentage: String(group?.percentage ?? '0'),
        }))
      : [],
  }
}

/** @param {any} data */
function parseTrend(data) {
  return {
    costTotals: {
      amount: String(data?.costTotals?.amount ?? '0'),
      pretaxAmount: String(data?.costTotals?.pretaxAmount ?? '0'),
      taxAmount: String(data?.costTotals?.taxAmount ?? '0'),
      currency: String(data?.costTotals?.currency ?? ''),
    },
    groupByTotal: Array.isArray(data?.groupByTotal)
      ? data.groupByTotal.map((group) => ({
          key: String(group?.key ?? ''),
          name: String(group?.name ?? ''),
          amount: String(group?.amount ?? '0'),
          pretaxAmount: String(group?.pretaxAmount ?? '0'),
          taxAmount: String(group?.taxAmount ?? '0'),
        }))
      : [],
    resultByTime: Array.isArray(data?.resultByTime)
      ? data.resultByTime.map((bucket) => ({
          period: String(bucket?.period ?? ''),
          total: {
            amount: String(bucket?.total?.amount ?? '0'),
            pretaxAmount: String(bucket?.total?.pretaxAmount ?? '0'),
            taxAmount: String(bucket?.total?.taxAmount ?? '0'),
            currency: String(bucket?.total?.currency ?? ''),
          },
          periodDetails: Array.isArray(bucket?.periodDetails)
            ? bucket.periodDetails.map((detail) => ({
                key: String(detail?.key ?? ''),
                name: String(detail?.name ?? ''),
                amount: String(detail?.amount ?? '0'),
                pretaxAmount: String(detail?.pretaxAmount ?? '0'),
                taxAmount: String(detail?.taxAmount ?? '0'),
                percentage: String(detail?.percentage ?? '0'),
              }))
            : [],
        }))
      : [],
  }
}
