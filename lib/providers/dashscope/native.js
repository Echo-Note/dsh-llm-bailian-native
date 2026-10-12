/**
 * Aliyun Bailian / DashScope — **native protocol** adapter.
 *
 * This adapter speaks the DashScope native HTTP surface only. It never targets
 * `/compatible-mode/v1` (the OpenAI-compatible surface), which the existing
 * `bailian` route in this profile already covers.
 *
 * ## Endpoint shape
 *
 *   POST {origin}/api/v1/services/aigc/text-generation/generation        (plain text models)
 *   POST {origin}/api/v1/services/aigc/multimodal-generation/generation  (VL / multimodal-capable)
 *   GET  {origin}/api/v1/models                                         (model catalog)
 *   Authorization: Bearer <API_KEY>
 *   X-DashScope-SSE: enable        (streaming only)
 *   body: { model, input: { messages }, parameters: { result_format: 'message', ... } }
 *
 * `origin` may be the public shared host (`https://dashscope.aliyuncs.com`) or a
 * workspace-dedicated Model Studio host
 * (`https://{WorkspaceId}.{region}.maas.aliyuncs.com`). Both serve the native
 * protocol with the same `sk-` key. `normalizeServiceRoot()` accepts a bare
 * origin *or* a full base URL (including one that already carries
 * `/compatible-mode/v1` or `/api/v1`) and reduces it to the origin, which is the
 * single most likely misconfiguration given that the neighbouring `bailian`
 * route's baseURL ends in `/compatible-mode/v1`.
 *
 * ## Native wire facts this code depends on (see README.md for sources)
 *
 * - Native SSE frames carry the *same* envelope as the non-streaming reply:
 *   `output.choices[0].message.content`, **not** `choices[0].delta.content`.
 * - `usage` is present on every chunk.
 * - With `incremental_output: true` each frame carries only new text; with
 *   `false` (the default) each frame carries the whole text so far. This adapter
 *   sets `true` and additionally diffs, so a provider that ignores the flag
 *   still produces correct token-level deltas.
 * - Non-final frames report `finish_reason` as the literal string `"null"`.
 * - There is no documented `data: [DONE]` sentinel on this surface; the stream
 *   ends at the frame whose `finish_reason` is a real value.
 * - `enable_thinking: true` requires streaming **and** `result_format: 'message'`.
 *
 * @module @local/dsh-llm-bailian-native/providers/dashscope/native
 */

import { FAILURE_CODES, failure } from '../../protocol.js'

/** Native path for plain text models. */
export const TEXT_GENERATION_PATH = '/api/v1/services/aigc/text-generation/generation'
/** Native path for vision / multimodal-capable models. */
export const MULTIMODAL_GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** Native model-catalog path. */
export const MODELS_PATH = '/api/v1/models'

/**
 * Published visual-token rule: images are aligned to a 32 px grid, then
 * `tokens = int(h*w/(32*32)) + 2`, with a per-image cap.
 * @see https://help.aliyun.com/zh/model-studio/vision-model
 */
const VL_PATCH_PX = 32
const VL_MAX_VISUAL_TOKENS = 1280
/** Cap once `vl_high_resolution_images` is enabled. */
const VL_MAX_VISUAL_TOKENS_HIGH_RES = 16384
/** DashScope refuses an inline image larger than this. */
const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Reduce a configured base URL to a service origin.
 *
 * Accepts, and normalizes to the same origin:
 *   https://dashscope.aliyuncs.com
 *   https://dashscope.aliyuncs.com/api/v1
 *   https://llm-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
 *   https://llm-x.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation
 *
 * @param {string} raw
 * @returns {string} origin without a trailing slash
 */
export function normalizeServiceRoot(raw) {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return trimmed
  // Only strip a known protocol prefix; an unknown path is left alone so the
  // user's custom gateway prefix keeps working.
  const known = [
    '/api/v1/services/aigc/multimodal-generation/generation',
    '/api/v1/services/aigc/text-generation/generation',
    '/api/v1/services/aigc/multimodal-generation',
    '/api/v1/services/aigc/text-generation',
    '/compatible-mode/v1',
    '/apps/anthropic',
    '/api/v1',
  ]
  for (const suffix of known) {
    if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length).replace(/\/+$/, '')
  }
  return trimmed
}

/**
 * DashScope failure codes → the harness's provider-neutral vocabulary.
 * Matched with `test()` against the `code` string; `i` where the provider mixes
 * casing between surfaces (`InvalidApiKey` vs `invalid_api_key`).
 * @type {ReadonlyArray<{ test: RegExp, code: string }>}
 */
const ERROR_CODE_RULES = Object.freeze([
  // 401 — bad key, or a key from the wrong region/workspace/billing plan.
  { test: /^InvalidApiKey$|^invalid_api_key$|^NOT AUTHORIZED$|^Unauthorized$|^Authentication/i, code: FAILURE_CODES.AUTH },
  // 429 — RPM/TPM throttling.
  { test: /^Throttling\.RateQuota$|^Throttling$|^RequestLimitExceeded$|^RequestsRateLimitExceeded$/i, code: FAILURE_CODES.RATE_LIMIT },
  // Balance / quota, either exhausted or unavailable.
  { test: /^Arrearage$|^isv\.OUT_OF_SERVICE$|^AllocationQuota\.FreeTierOnly$|^Throttling\.AllocationQuota$|^AllocationQuota|^FreeQuota|InsufficientBalance/i, code: FAILURE_CODES.QUOTA },
  // Context / input length.
  { test: /Range of input length|context_length_exceeded|ContextLength|^InputLengthTooLong$/i, code: FAILURE_CODES.CONTEXT_WINDOW_EXCEEDED },
  // Transient backend.
  { test: /^InternalError$|^InternalError\.Algo|^ServiceUnavailable$|No backend server available|^SystemError/i, code: FAILURE_CODES.SERVER },
  // Caller-side request defects.
  { test: /^InvalidParameter$|^InvalidParameter\.|^BadRequest|^DataInspectionFailed$|^data_inspection_failed$|^InvalidURL|^Model\.AccessDenied$|^InvalidFile$/i, code: FAILURE_CODES.INVALID_REQUEST },
])

/**
 * Map one DashScope error body onto a stable failure.
 * @param {number} status
 * @param {unknown} payload
 * @param {Headers} [headers]
 * @returns {import('../../protocol.js').ProtocolFailure}
 */
export function mapError(status, payload, headers) {
  const body = asRecord(payload)
  const output = asRecord(body.output)
  const providerCode = firstString(body.code, output.code)
  const providerMessage = firstString(body.message, output.message)
  const requestId = firstString(body.request_id, headers?.get('x-dashscope-request-id') ?? undefined)

  /** @type {string | undefined} */
  let code
  // Message-first: DashScope reports several conditions under the umbrella code
  // `InternalError.Algo.InvalidParameter` and distinguishes them *only* by the
  // message ("Range of input length…" is context overflow, not a server fault).
  if (providerMessage !== undefined) {
    if (/range of input length|input length should be|context length|context_length_exceeded|input is too long/i.test(providerMessage)) {
      code = FAILURE_CODES.CONTEXT_WINDOW_EXCEEDED
    } else if (/model not exist|model not found|model not open/i.test(providerMessage)) {
      code = FAILURE_CODES.INVALID_REQUEST
    }
  }
  if (code === undefined && providerCode !== undefined) {
    for (const rule of ERROR_CODE_RULES) {
      if (rule.test.test(providerCode)) {
        code = rule.code
        break
      }
    }
  }
  if (code === undefined) {
    if (status === 401 || status === 403) code = FAILURE_CODES.AUTH
    else if (status === 429) code = FAILURE_CODES.RATE_LIMIT
    else if (status === 402) code = FAILURE_CODES.QUOTA
    else if (status >= 500) code = FAILURE_CODES.SERVER
    // Only the statuses the provider actually documents as request defects are
    // folded into INVALID_REQUEST; anything else keeps its own HTTP_<status> code
    // so an upstream gateway's nonstandard status stays visible.
    else if (status === 400 || status === 404 || status === 422) code = FAILURE_CODES.INVALID_REQUEST
    else code = `HTTP_${status}`
  }

  const retryAfter = retryAfterMs(headers)
  const summary = providerMessage ?? `DashScope answered HTTP ${status}`
  const named = providerCode === undefined ? summary : `${providerCode}: ${summary}`
  return {
    code,
    message: requestId === undefined ? named : `${named} (request_id ${requestId})`,
    status,
    ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

/**
 * Read `Retry-After` in milliseconds, in either of its two legal forms.
 * @param {Headers | undefined} headers
 * @returns {number | undefined}
 */
function retryAfterMs(headers) {
  const raw = headers?.get('retry-after')
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return Math.max(0, at - Date.now())
  return undefined
}

/**
 * Choose the native generation path for one exact model.
 *
 * The sub-path is **model-class dependent**, not modality dependent, and
 * getting it wrong is a documented failure mode (`url error`): the newest
 * Qwen3.5/3.6/3.7/3.8 flagship and thinking models are documented on the
 * multimodal path even when the request carries only text.
 *
 * Precedence: an explicit per-model override → a `-vl`/`-omni` id → a
 * multimodal-class family prefix → the text path.
 *
 * @param {import('../../protocol.js').ResolvedRoute} route
 * @param {string} model
 * @returns {{ path: string, reason: string }}
 */
export function generationPathFor(route, model) {
  const forced = route.generationPath
  if (forced === 'text') return { path: TEXT_GENERATION_PATH, reason: 'route pinned to the text path' }
  if (forced === 'multimodal') return { path: MULTIMODAL_GENERATION_PATH, reason: 'route pinned to the multimodal path' }

  const override = route.generationPathOverrides?.[model]
  if (override === 'text') return { path: TEXT_GENERATION_PATH, reason: 'per-model override' }
  if (override === 'multimodal') return { path: MULTIMODAL_GENERATION_PATH, reason: 'per-model override' }

  const lower = model.toLowerCase()
  if (/(^|[/-])vl([-/]|$)|omni|vision|ocr/.test(lower)) {
    return { path: MULTIMODAL_GENERATION_PATH, reason: 'vision/omni model id' }
  }
  // Qwen3.5 and later flagship/thinking models are documented on the multimodal
  // path even for text-only requests; posting them to text-generation is the
  // documented `url error` failure mode.
  if ((route.multimodalFamilies ?? []).some((prefix) => lower.startsWith(prefix.toLowerCase()))) {
    return { path: MULTIMODAL_GENERATION_PATH, reason: 'model family is documented on the multimodal path' }
  }
  return { path: TEXT_GENERATION_PATH, reason: 'plain text model' }
}

/**
 * Whether the exact model accepts image input, per the resolved catalog.
 * Defaults to text-only: an undeclared modality is a negative capability, and
 * the harness then substitutes deterministic image placeholders rather than
 * letting an image reach a model that would reject it.
 * @param {import('../../protocol.js').ResolvedRoute} route
 * @param {string} model
 * @returns {boolean}
 */
export function modelSupportsImages(route, model) {
  return route.models.find((candidate) => candidate.id === model)?.inputModalities?.includes('image') === true
}

/**
 * Visual tokens for one retained request image, using the published qwen-vl
 * rule: 28 px patches, 2×2 downsampling, capped per image.
 *
 * Used only for *pre-request* image pressure pricing (`imageRequestPricing`);
 * reported usage (including `usage.image_tokens`) stays authoritative.
 * @returns {{ visualTokens: number, text: string }}
 */
export function priceImageRequest() {
  return {
    visualTokens: VL_MAX_VISUAL_TOKENS,
    text: `DashScope aligns each image to a ${VL_PATCH_PX}px grid and bills int(h*w/${VL_PATCH_PX * VL_PATCH_PX}) + 2 tokens (≤${VL_MAX_VISUAL_TOKENS}/image, ≤${VL_MAX_VISUAL_TOKENS_HIGH_RES} with vl_high_resolution_images); reported usage.image_tokens is authoritative`,
  }
}

/**
 * Exact visual-token count for one image size, following the published rule:
 * align to a 32 px grid, then `int(h*w/(32*32)) + 2`.
 * @param {number} width
 * @param {number} height
 * @param {{ highResolution?: boolean }} [options]
 * @returns {number}
 */
export function visualTokensFor(width, height, options = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0
  const aligned = (value) => Math.max(VL_PATCH_PX, Math.round(value / VL_PATCH_PX) * VL_PATCH_PX)
  const tokens = Math.floor((aligned(width) * aligned(height)) / (VL_PATCH_PX * VL_PATCH_PX)) + 2
  // The documented caps are inclusive totals, so the `+2` overhead is inside them.
  const cap = options.highResolution === true ? VL_MAX_VISUAL_TOKENS_HIGH_RES : VL_MAX_VISUAL_TOKENS
  return Math.min(cap, Math.max(1, tokens))
}

/**
 * Serialize harness content blocks into a DashScope native message.
 *
 * Native message shape: `{ role, content }` where `content` is a string for
 * text-only turns and an array of parts for multimodal turns. Native image parts
 * are `{ image: '<url|data-url>' }` — **not** the compatible surface's
 * `{ type: 'image_url', image_url: { url } }`.
 *
 * `reasoning` blocks are deliberately not replayed: the documented native
 * request shape carries `enable_thinking`/`preserve_thinking` switches, not a
 * reasoning field on history messages.
 *
 * @param {import('../../protocol.js').HarnessMessage} message
 * @returns {Record<string, unknown> | undefined}
 */
function serializeMessage(message) {
  const role = typeof message.role === 'string' ? message.role : undefined
  if (role === undefined) return undefined
  const blocks = Array.isArray(message.content) ? message.content : []
  const parts = []
  const texts = []

  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) {
          parts.push({ text: block.text })
          texts.push(block.text)
        }
        break
      case 'reasoning':
        break
      case 'tool-call':
        break
      case 'image': {
        const url = imageUrlOf(block.attachment)
        if (url !== undefined) parts.push({ image: url })
        break
      }
      case 'file':
        // The harness replaces durable file references with handle text before
        // dispatch; a `file` block reaching here is a contract violation.
        throw failure(FAILURE_CODES.UNSUPPORTED_CONTENT, 'DashScope native protocol cannot carry a durable file reference in a message')
      default:
        break
    }
  }

  const toolCalls = blocks
    .filter((block) => block?.type === 'tool-call')
    .map((block) => ({
      id: typeof block.id === 'string' && block.id.length > 0 ? block.id : `call_${Math.random().toString(36).slice(2)}`,
      type: 'function',
      function: {
        name: String(block.name ?? ''),
        arguments: typeof block.arguments === 'string' && block.arguments.length > 0 ? block.arguments : '{}',
      },
    }))

  if (role === 'tool') {
    const toolCallId = firstString(message.toolCallId, toolCalls[0]?.id)
    return {
      role: 'tool',
      content: texts.join('\n'),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    }
  }

  if (role === 'assistant') {
    if (parts.length === 0 && toolCalls.length === 0) return undefined
    return {
      role: 'assistant',
      content: parts.some((part) => 'image' in part) ? parts : texts.join('\n'),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    }
  }

  if (parts.length === 0) return undefined
  return {
    role: role === 'developer' ? 'system' : role,
    content: parts.some((part) => 'image' in part) ? parts : texts.join('\n'),
  }
}

/**
 * Read an image URL off a projected image attachment.
 *
 * The harness strips durable attachment *bytes* before dispatch, so a data URL
 * is present only when a caller supplied an inline reference. When it is absent
 * this returns `undefined` and the message loses the image; that is why the
 * bundled catalog declares image modality only for VL models and the README
 * records the in-flight limitation.
 *
 * @param {unknown} attachment
 * @returns {string | undefined}
 */
function imageUrlOf(attachment) {
  const record = asRecord(attachment)
  const dataUrl = firstString(record.dataUrl)
  if (dataUrl !== undefined && dataUrl.startsWith('data:')) {
    if (dataUrl.length > MAX_INLINE_IMAGE_BYTES) {
      throw failure(FAILURE_CODES.UNSUPPORTED_CONTENT, `inline image exceeds the DashScope ${MAX_INLINE_IMAGE_BYTES}-byte base64 limit; offload it or use a smaller image`)
    }
    return dataUrl
  }
  const base64 = firstString(record.base64)
  const mediaType = firstString(record.mediaType)
  if (base64 !== undefined && mediaType !== undefined) {
    if (base64.length > MAX_INLINE_IMAGE_BYTES) {
      throw failure(FAILURE_CODES.UNSUPPORTED_CONTENT, `inline image exceeds the DashScope ${MAX_INLINE_IMAGE_BYTES}-byte base64 limit; offload it or use a smaller image`)
    }
    return `data:${mediaType};base64,${base64}`
  }
  const url = firstString(record.url)
  if (url !== undefined && /^https?:\/\//.test(url)) return url
  return undefined
}

/**
 * Build the native generation request.
 * @param {object} input
 * @param {import('../../protocol.js').ResolvedRoute} input.route
 * @param {import('../../protocol.js').GenerateOptions} input.options
 * @param {string | undefined} input.apiKey
 * @param {boolean} input.stream
 * @returns {{ url: string, headers: Record<string, string>, body: string, path: string, pathReason: string }}
 */
export function buildRequest({ route, options, apiKey, stream }) {
  const messages = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const serialized = serializeMessage(message)
    if (serialized !== undefined) messages.push(serialized)
  }
  if (messages.length === 0) {
    throw failure(FAILURE_CODES.INVALID_REQUEST, 'DashScope native generation needs at least one message')
  }

  const thinking = thinkingParameters(route, options)
  if (thinking.enabled && !stream) {
    // Documented: `enable_thinking` is stream-only, and the provider rejects a
    // non-streaming thinking request with an `InvalidParameter` error. Failing
    // locally with a precise code beats sending a request known to be rejected.
    throw failure(
      FAILURE_CODES.INVALID_REQUEST,
      `DashScope requires streaming when thinking is enabled (model "${options.model}"); retry with streaming or set reasoningEffort to "off"`,
    )
  }

  const { path, reason } = generationPathFor(route, options.model)

  /** @type {Record<string, unknown>} */
  const parameters = {
    // Required whenever tools or thinking are used, and the documented shape we
    // read for both streaming and non-streaming replies.
    result_format: 'message',
  }
  if (stream) {
    // `incremental_output` is what makes native frames carry deltas instead of
    // the whole text so far; it is also mandatory in thinking mode.
    parameters.stream = true
    parameters.incremental_output = true
  }
  if (Number.isFinite(options.temperature)) parameters.temperature = options.temperature
  if (Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    // `max_tokens` is documented as heading for deprecation in favour of
    // `max_completion_tokens`, which also bounds thinking. Prefer the new field,
    // keep the old one for models that have not migrated.
    parameters.max_tokens = Math.floor(options.maxTokens)
    parameters.max_completion_tokens = Math.floor(options.maxTokens)
  }
  if (Array.isArray(options.stop) && options.stop.length > 0) parameters.stop = options.stop
  Object.assign(parameters, thinking.parameters)

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    parameters.tools = options.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    parameters.tool_choice = 'auto'
    // Stream tool arguments as they are produced; documented for Qwen and GLM.
    if (stream) parameters.tool_stream = true
  }

  const body = JSON.stringify({ model: options.model, input: { messages }, parameters })

  return {
    url: `${route.baseURL}${path}`,
    headers: {
      'content-type': 'application/json',
      accept: stream ? 'text/event-stream' : 'application/json',
      authorization: `Bearer ${apiKey ?? ''}`,
      ...(stream ? { 'x-dashscope-sse': 'enable' } : {}),
      ...route.headers,
    },
    body,
    path,
    pathReason: reason,
  }
}

/**
 * Translate the harness reasoning effort into DashScope's thinking switches.
 *
 * `off` sends an explicit `false` rather than omitting the field, so a
 * thinking-by-default model does not silently think when the caller asked it not
 * to. `thinking_budget` and `reasoning_effort` are mutually exclusive on the
 * newest models, so only the budget (which the catalog can express per effort) is
 * sent.
 *
 * @param {import('../../protocol.js').ResolvedRoute} route
 * @param {import('../../protocol.js').GenerateOptions} options
 * @returns {{ enabled: boolean, parameters: Record<string, unknown> }}
 */
function thinkingParameters(route, options) {
  const effort = firstString(options.reasoningEffort)
  if (effort === undefined) return { enabled: false, parameters: {} }
  if (effort === 'off') return { enabled: false, parameters: { enable_thinking: false } }
  const entry = route.models.find((candidate) => candidate.id === options.model)
  const budget = entry?.thinkingBudgets?.[effort] ?? route.thinkingBudgets?.[effort]
  return {
    enabled: true,
    parameters: {
      enable_thinking: true,
      ...(Number.isFinite(budget) && budget > 0 ? { thinking_budget: Math.floor(budget) } : {}),
    },
  }
}

/** @param {unknown} payload @returns {string | undefined} */
export function requestIdOf(payload) {
  return firstString(asRecord(payload).request_id)
}

/**
 * Locate the first choice of a native reply.
 * @param {unknown} payload
 * @returns {Record<string, any> | undefined}
 */
export function firstChoice(payload) {
  const out = asRecord(asRecord(payload).output)
  const choices = Array.isArray(out.choices) ? out.choices : []
  const first = asRecord(choices[0])
  return Object.keys(first).length === 0 ? undefined : first
}

/**
 * Read the accumulated text of a native reply.
 *
 * Handles every documented native shape: `message.content` as a string (plain
 * text models), as an array of `{ text }` parts (multimodal models), and the
 * legacy `output.text` / `choice.text` forms.
 * @param {unknown} payload
 * @returns {string}
 */
export function textOf(payload) {
  const choice = firstChoice(payload)
  const message = asRecord(choice?.message)
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        const record = asRecord(part)
        if (typeof record.text === 'string') return record.text
        const nested = asRecord(record.text)
        return typeof nested.text === 'string' ? nested.text : ''
      })
      .join('')
  }
  const out = asRecord(asRecord(payload).output)
  if (typeof out.text === 'string') return out.text
  if (typeof choice?.text === 'string') return choice.text
  return ''
}

/**
 * Read thinking text of a native reply.
 * @param {unknown} payload
 * @returns {string}
 */
export function reasoningOf(payload) {
  const message = asRecord(firstChoice(payload)?.message)
  if (typeof message.reasoning_content === 'string') return message.reasoning_content
  const out = asRecord(asRecord(payload).output)
  if (typeof out.reasoning_content === 'string') return out.reasoning_content
  return ''
}

/**
 * Read tool calls of a native reply.
 * @param {unknown} payload
 * @returns {Array<{ id: string, name: string, arguments: string }>}
 */
export function toolCallsOf(payload) {
  const message = asRecord(firstChoice(payload)?.message)
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  return calls.map((call, index) => {
    const record = asRecord(call)
    const fn = asRecord(record.function)
    return {
      id: firstString(record.id) ?? `call_${index}`,
      name: firstString(fn.name) ?? '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    }
  })
}

/**
 * Read the provider finish reason.
 *
 * Non-final native frames report the **string** `"null"`, so a truthiness test
 * would treat every frame as final; only real reasons are returned.
 * @param {unknown} payload
 * @returns {string | undefined}
 */
export function finishReasonOf(payload) {
  const choice = firstChoice(payload)
  const out = asRecord(asRecord(payload).output)
  for (const candidate of [choice?.finish_reason, out.finish_reason]) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate !== 'null') return candidate
  }
  return undefined
}

/**
 * Read token usage of a native reply.
 *
 * `usage` is documented on every native stream frame, so the caller can keep the
 * last non-empty one. `image_tokens` is reported for multimodal replies; it is
 * folded into `inputTokens` because DashScope bills it as input.
 * @param {unknown} payload
 * @returns {import('../../protocol.js').TokenUsage | undefined}
 */
export function usageOf(payload) {
  const usage = asRecord(asRecord(payload).usage)
  const imageTokens = numberOr(usage.image_tokens) ?? 0
  const rawInput = numberOr(usage.input_tokens)
  const output = numberOr(usage.output_tokens)
  if (rawInput === undefined && output === undefined) return undefined
  const details = asRecord(usage.prompt_tokens_details)
  const cached = numberOr(usage.cache_read_input_tokens) ?? numberOr(details.cached_tokens) ?? numberOr(usage.cached_tokens)
  const cacheWrite = numberOr(usage.cache_creation_input_tokens)
  const reasoning = numberOr(asRecord(usage.output_tokens_details).reasoning_tokens) ?? numberOr(usage.reasoning_tokens)
  const total = numberOr(usage.total_tokens)
  const input = (rawInput ?? 0) + imageTokens
  return {
    inputTokens: input,
    outputTokens: output ?? 0,
    totalTokens: total ?? input + (output ?? 0),
    ...(cached === undefined ? {} : { cacheReadTokens: cached }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

/**
 * Translate a non-streaming native reply into adapter facts.
 * @param {unknown} payload
 */
export function parseReply(payload) {
  const requestId = requestIdOf(payload)
  const usage = usageOf(payload)
  return {
    text: textOf(payload),
    reasoning: reasoningOf(payload),
    toolCalls: toolCallsOf(payload),
    finishReason: finishReasonOf(payload),
    ...(usage === undefined ? {} : { usage }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

/**
 * Translate one native SSE frame.
 *
 * Returns the frame's raw accumulated text; `lib/stream.js` diffs it against what
 * it has already emitted, so `incremental_output: true` and `false` both yield
 * correct token-level deltas.
 *
 * @param {unknown} payload
 */
export function parseStreamFrame(payload) {
  const body = asRecord(payload)
  const requestId = requestIdOf(payload)
  if (typeof body.code === 'string' && body.code.length > 0) {
    return {
      text: '',
      reasoning: '',
      toolCalls: [],
      failure: mapError(200, body),
      ...(requestId === undefined ? {} : { requestId }),
    }
  }
  const message = asRecord(firstChoice(payload)?.message)
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const usage = usageOf(payload)
  const finishReason = finishReasonOf(payload)
  return {
    text: textOf(payload),
    reasoning: reasoningOf(payload),
    toolCalls: calls.map((call, index) => {
      const record = asRecord(call)
      const fn = asRecord(record.function)
      return {
        index: numberOr(record.index) ?? index,
        id: firstString(record.id) ?? '',
        name: firstString(fn.name) ?? '',
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
      }
    }),
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(usage === undefined ? {} : { usage }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

/**
 * Query the native model catalog: `GET /api/v1/models`.
 *
 * This endpoint is documented and returns `output.models[]` with `model`,
 * `name`, `provider`, `inference_metadata.{request_modality,response_modality}`
 * and `model_info.{context_window,max_output_tokens}`. It is the authoritative
 * source for this adapter's discovery.
 *
 * @param {object} input
 * @param {import('../../protocol.js').ResolvedRoute} input.route
 * @param {string | undefined} input.apiKey
 * @param {AbortSignal} [input.signal]
 * @param {number} [input.pageSize]
 * @param {number} [input.maxPages] cap so a large catalog cannot fetch forever
 * @param {(message: string) => void} [input.onNotice]
 * @returns {Promise<{ supported: boolean, models?: Array<{ id: string, name: string, contextWindow?: number, maxTokens?: number, inputModalities?: Array<'text'|'image'> }>, notice?: string, requestId?: string }>}
 */
export async function listEndpointModels({ route, apiKey, signal, pageSize = 100, maxPages = 5, onNotice } = {}) {
  if (apiKey === undefined || apiKey.length === 0) {
    return { supported: false, notice: 'listing models needs a resolved credential' }
  }
  /** @type {Map<string, { id: string, name: string, contextWindow?: number, maxTokens?: number, inputModalities?: Array<'text'|'image'>, snapshotOf?: string, advertisedPrices?: Array<{ type: string, price: number, priceUnit: string, rangeName: string }> }>} */
  const found = new Map()
  /** @type {string | undefined} */
  let requestId
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${route.baseURL}${MODELS_PATH}?page_no=${page}&page_size=${pageSize}`
    let response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...route.headers,
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (page === 1) {
        return { supported: false, notice: `could not reach the native model catalog: ${messageOf(error)}` }
      }
      onNotice?.(`model catalog page ${page} failed after page ${page - 1} succeeded: ${messageOf(error)}`)
      break
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined)
      const mapped = mapError(response.status, payload, response.headers)
      if (page === 1) return { supported: false, notice: `${mapped.code}: ${mapped.message}` }
      onNotice?.(`model catalog page ${page} rejected with ${mapped.code} after page ${page - 1} succeeded`)
      break
    }
    const payload = await response.json().catch(() => undefined)
    const output = asRecord(asRecord(payload).output)
    requestId = firstString(asRecord(payload).request_id) ?? requestId
    const rows = Array.isArray(output.models) ? output.models : Array.isArray(asRecord(payload).models) ? asRecord(payload).models : []
    for (const row of rows) {
      const record = asRecord(row)
      const id = firstString(record.model, record.id)
      if (id === undefined || found.has(id)) continue
      const info = asRecord(record.model_info)
      const inference = asRecord(record.inference_metadata)
      const contextWindow = numberOr(info.context_window)
      const maxTokens = numberOr(info.max_output_tokens)
      const snapshotOf = firstString(record.equivalent_snapshot)
      const modalities = modalitiesOf(record, inference)
      const advertisedPrices = pricesOf(record)
      found.set(id, {
        id,
        name: firstString(record.name) ?? id,
        ...(contextWindow === undefined ? {} : { contextWindow: Math.floor(contextWindow) }),
        ...(maxTokens === undefined ? {} : { maxTokens: Math.floor(maxTokens) }),
        ...(modalities === undefined ? {} : { inputModalities: modalities }),
        // `equivalent_snapshot` is the documented alias → snapshot link; the
        // price table keys on it so a rolling alias and its dated snapshot share
        // one row.
        ...(snapshotOf === undefined || snapshotOf === id ? {} : { snapshotOf }),
        ...(advertisedPrices.length === 0 ? {} : { advertisedPrices }),
      })
    }
    const total = numberOr(output.total)
    const size = numberOr(output.page_size) ?? pageSize
    if (rows.length === 0 || (total !== undefined && page * size >= total)) break
  }
  if (found.size === 0) return { supported: false, notice: 'the native model catalog answered but listed no models', ...(requestId === undefined ? {} : { requestId }) }
  return { supported: true, models: [...found.values()], ...(requestId === undefined ? {} : { requestId }) }
}

/**
 * Flatten a catalog row's `prices[]` block.
 *
 * Documented shape:
 * `prices: [{ range_name, prices: [{ type: 'input_token'|'output_token'|..., price, price_unit, price_name }] }]`
 * `price_unit` is "per million tokens", the same unit the ledger uses. The
 * documented sample carries **no currency field**, so these numbers are recorded
 * as *advertised* facts and are never silently adopted as the billing currency —
 * the route's configured `pricing.currency` stays authoritative.
 * @param {Record<string, any>} record
 */
function pricesOf(record) {
  const ranges = Array.isArray(record.prices) ? record.prices : []
  const result = []
  for (const range of ranges) {
    const rangeRecord = asRecord(range)
    const rangeName = firstString(rangeRecord.range_name) ?? 'Default'
    const rows = Array.isArray(rangeRecord.prices) ? rangeRecord.prices : []
    for (const row of rows) {
      const entry = asRecord(row)
      const type = firstString(entry.type)
      const price = numberOr(entry.price)
      if (type === undefined || price === undefined) continue
      result.push({ type, price, priceUnit: firstString(entry.price_unit) ?? '', rangeName })
    }
  }
  return result
}

/**
 * Decide input modalities for one catalog row.
 * `request_modality` is documented as something like `["text"]` / `["text","image"]`.
 * @param {Record<string, any>} record
 * @param {Record<string, any>} inference
 */
function modalitiesOf(record, inference) {
  const declared = Array.isArray(inference.request_modality)
    ? inference.request_modality
    : Array.isArray(record.request_modality)
      ? record.request_modality
      : undefined
  if (declared === undefined) {
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities.map(String) : []
    const features = Array.isArray(record.features) ? record.features.map(String) : []
    const vision = capabilities.some((value) => value === 'VU' || value === 'Multimodal-Omni') || features.includes('vision')
    return vision ? ['text', 'image'] : undefined
  }
  const mapped = declared.map((value) => String(value).toLowerCase()).filter((value) => value === 'text' || value === 'image')
  return mapped.length === 0 ? undefined : [...new Set(mapped)]
}

/**
 * Connectivity self-check for the settings UI.
 *
 * The model catalog is the cheapest authenticated native call that proves the
 * origin, the key and the region/workspace alignment all at once, so the probe
 * uses it first and falls back to a minimal generation call when the catalog
 * route is unavailable on a given gateway.
 *
 * @param {import('../../protocol.js').ResolvedRoute} route
 * @param {string | undefined} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../../protocol.js').ProbeResult>}
 */
export async function probe(route, apiKey, signal) {
  const started = Date.now()
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      ok: false,
      code: FAILURE_CODES.MISSING_CREDENTIAL,
      message: `route "${route.route}" has no resolved credential; set ${route.apiKeyEnv ?? 'apiKeyEnv'} through the credentials seam`,
    }
  }

  try {
    const catalog = await listEndpointModels({ route, apiKey, signal, maxPages: 1, pageSize: 5 })
    if (catalog.supported) {
      return {
        ok: true,
        message: `native model catalog answered (${catalog.models?.length ?? 0} models on page 1)`,
        latencyMs: Date.now() - started,
        models: (catalog.models ?? []).map((entry) => entry.id),
        ...(catalog.requestId === undefined ? {} : { requestId: catalog.requestId }),
      }
    }
    const notice = catalog.notice ?? 'the native model catalog was unavailable'
    const model = pickProbeModel(route)
    const request = buildRequest({
      route,
      apiKey,
      stream: false,
      options: {
        provider: route.route,
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxTokens: 1,
      },
    })
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      ...(signal === undefined ? {} : { signal }),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok) {
      const mapped = mapError(response.status, payload, response.headers)
      return {
        ok: false,
        code: mapped.code,
        message: `${mapped.message} (model catalog: ${notice})`,
        status: response.status,
        latencyMs: Date.now() - started,
        ...(mapped.requestId === undefined ? {} : { requestId: mapped.requestId }),
      }
    }
    const body = asRecord(payload)
    if (typeof body.code === 'string' && body.code.length > 0) {
      const mapped = mapError(200, payload, response.headers)
      return { ok: false, code: mapped.code, message: `${mapped.message} (model catalog: ${notice})`, latencyMs: Date.now() - started }
    }
    const parsed = parseReply(payload)
    return {
      ok: true,
      message: `native generation endpoint answered for model "${model}"; model catalog: ${notice}`,
      status: response.status,
      latencyMs: Date.now() - started,
      ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
    }
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, code: FAILURE_CODES.ABORTED, message: 'connectivity check aborted' }
    const code = firstString(/** @type {{ code?: unknown }} */ (error)?.code) ?? FAILURE_CODES.TRANSPORT
    return { ok: false, code, message: messageOf(error) }
  }
}

/** @param {import('../../protocol.js').ResolvedRoute} route */
function pickProbeModel(route) {
  const enabled = route.models.filter((model) => !route.modelDisabled.includes(model.id))
  const textOnly = enabled.find((model) => !model.inputModalities?.includes('image'))
  return (textOnly ?? enabled[0] ?? route.models[0])?.id ?? 'qwen-turbo'
}

/** @param {unknown} value @returns {Record<string, any>} */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {}
}

/** @param {...unknown} values @returns {string | undefined} */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** @param {unknown} value @returns {number | undefined} */
function numberOr(value) {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** The adapter object this module contributes to the protocol registry. */
export const dashscopeNative = Object.freeze({
  protocol: 'dashscope-native',
  vendor: 'aliyun',
  vendorDisplayName: '阿里云百炼',
  defaultBaseURLs: [
    // The public shared host entered maintenance on 2026-09-20 and receives no
    // new features; a workspace-dedicated host is the forward-looking target.
    'https://dashscope.aliyuncs.com',
    'https://dashscope-intl.aliyuncs.com',
  ],
  defaultApiKeyEnvs: ['DASHSCOPE_API_KEY', 'BAILIAN_API_KEY'],
  defaultModels: ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-plus', 'qwen3-vl-plus'],
  /**
   * Model-family prefixes documented on the multimodal generation path even for
   * text-only requests. Consumed by `generationPathFor()` and by config
   * resolution, so a route's `generationPath: auto` behaves correctly.
   */
  multimodalModelPrefixes: ['qwen3.8', 'qwen3.7', 'qwen3.6', 'qwen3.5', 'qwen3-vl', 'qwen3-omni'],
  buildRequest,
  parseReply,
  parseStreamFrame,
  mapError,
  modelSupportsImages,
  priceImageRequest,
  probe,
  listEndpointModels,
  normalizeServiceRoot,
  generationPathFor,
})
