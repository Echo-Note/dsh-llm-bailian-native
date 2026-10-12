/**
 * Provider-neutral protocol contract for this bundle.
 *
 * The plugin is a *multi-provider* adapter host: every cloud vendor that speaks
 * its own native protocol is a `ProtocolAdapter` registered in `registry.js`.
 * This release ships exactly one adapter — Aliyun Bailian / DashScope native
 * (`providers/dashscope/native.js`). Tencent Cloud (Hunyuan / 腾讯云) and Baidu
 * Cloud (Qianfan / 百度智能云千帆) are intentionally **not implemented** here;
 * they are declared by this contract so a later release adds a directory under
 * `lib/providers/` and one `registerProtocol()` call, with no change to the
 * adapter core, the pricing/ledger code, or the UI.
 *
 * Stability note: DSH is a preview product. Everything version-sensitive
 * (the `@deepseek-ai/dsh-llm` exports this bundle consumes, the settings and
 * credentials service calls, and the Client module format) is confined to
 * `lib/index.js`, `lib/credentials.js`, `lib/ledger.js` and `lib/client.js`.
 * The wire code in `lib/providers/**` depends on nothing but `fetch`,
 * `AbortSignal` and `TextDecoder`.
 *
 * @module @local/dsh-llm-bailian-native/protocol
 */

/**
 * A harness stream chunk. Written structurally (not imported) so the wire layer
 * never depends on a DSH package and cannot break on a preview-version refactor.
 *
 * Contract (enforced by `@deepseek-ai/dsh-llm`):
 * - token-level deltas, one `block-start` before the first delta of a block;
 * - `usage` strictly before `finish`;
 * - exactly one terminal `finish`, and nothing after it.
 *
 * @typedef {(
 *   | { type: 'block-start', index: number, blockType: 'text' | 'reasoning' | 'tool-call' }
 *   | { type: 'text-delta', index: number, text: string }
 *   | { type: 'reasoning-delta', index: number, text: string }
 *   | { type: 'tool-call-delta', index: number, id: string, name?: string, argumentsDelta: string }
 *   | { type: 'block-end', index: number, block: unknown }
 *   | { type: 'usage', usage: TokenUsage }
 *   | { type: 'finish', reason: FinishReason, replayState?: { response: unknown } }
 * )} StreamChunk
 */

/**
 * @typedef {object} TokenUsage
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} [totalTokens]
 * @property {number} [cacheReadTokens]
 * @property {number} [cacheWriteTokens]
 * @property {number} [reasoningTokens]
 */

/**
 * @typedef {{ kind: 'stop' }
 *   | { kind: 'tool-calls' }
 *   | { kind: 'max-tokens' }
 *   | { kind: 'aborted', failure: ProtocolFailure }
 *   | { kind: 'error', failure: ProtocolFailure }} FinishReason
 */

/**
 * A stable, provider-neutral failure. Consumers route on `code`, never on the
 * message text.
 *
 * @typedef {object} ProtocolFailure
 * @property {string} code
 * @property {string} message
 * @property {number} [status]
 * @property {number} [providerRetryAfterMs]
 * @property {string} [requestId]
 */

/**
 * The request the harness hands to an adapter, in the subset this bundle reads.
 *
 * @typedef {object} GenerateOptions
 * @property {string} provider
 * @property {string} model
 * @property {string} [system]
 * @property {ReadonlyArray<HarnessMessage>} messages
 * @property {ReadonlyArray<HarnessToolSchema>} [tools]
 * @property {string} [reasoningEffort]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {string[]} [stop]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} HarnessToolSchema
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} parameters
 */

/**
 * @typedef {object} HarnessMessage
 * @property {'system' | 'developer' | 'user' | 'assistant' | 'tool'} role
 * @property {ReadonlyArray<HarnessContentBlock>} [content]
 * @property {{ provider?: string, model?: string, kind?: string }} [source]
 * @property {string} [toolCallId]
 */

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'reasoning', text: string }
 *   | { type: 'image', attachment: unknown, offloaded?: true }
 *   | { type: 'file', attachment: unknown }
 *   | { type: 'tool-call', id: string, name: string, arguments: string }
 *   | { type: 'tool-addition', toolName: string }
 *   | { type: 'tool-removal', toolName: string }} HarnessContentBlock
 */

/**
 * One resolved provider route: the shape every wire adapter receives.
 *
 * @typedef {object} ResolvedRoute
 * @property {string} route          route id, e.g. `bailian-native`
 * @property {string} protocol       registry key, e.g. `dashscope-native`
 * @property {string} displayName
 * @property {string} baseURL        always without a trailing slash
 * @property {string | undefined} apiKeyEnv
 * @property {number} timeoutMs
 * @property {string | undefined} proxy
 * @property {number} streamIdleTimeoutMs
 * @property {string[]} modelDisabled
 * @property {number | undefined} defaultContextWindow
 * @property {readonly RouteModel[]} models
 * @property {readonly object[]} tools
 */

/**
 * @typedef {object} RouteModel
 * @property {string} id
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {ReadonlyArray<'text' | 'image'>} [inputModalities]
 * @property {Record<string, number>} [thinkingBudgets]
 */

/**
 * One raw provider reply, after SSE folding, before translation.
 *
 * @typedef {object} RawReply
 * @property {unknown} payload   the provider's own JSON object
 * @property {string} [requestId]
 */

/**
 * Result of a connectivity self-check, surfaced by the settings UI.
 *
 * @typedef {object} ProbeResult
 * @property {boolean} ok
 * @property {string} [code]      stable failure code when `ok` is false
 * @property {string} message
 * @property {number} [status]
 * @property {string} [requestId]
 * @property {number} [latencyMs]
 * @property {string[]} [models]
 */

/**
 * A wire adapter for exactly one provider family.
 *
 * Adding a provider (this is the seam Tencent Cloud and Baidu Cloud will use):
 *  1. create `lib/providers/<vendor>/<protocol>.js` exporting this shape;
 *  2. call `registerProtocol('tencent-native', adapter)` from `lib/providers/index.js`.
 * Nothing else in the bundle changes: configuration, credential resolution,
 * pricing, the ledger, discovery plumbing and the UI are all provider-neutral.
 *
 * @typedef {object} ProtocolAdapter
 * @property {string} protocol          registry key; matches `route.protocol`
 * @property {string} vendor            `aliyun` | `tencent` | `baidu` | …
 * @property {string} vendorDisplayName
 * @property {string[]} defaultBaseURLs documented endpoints, most public first
 * @property {string[]} defaultApiKeyEnvs credential references to try in order
 * @property {string[]} defaultModels   bundled catalog model ids
 * @property {ReadonlyArray<{ id: string, name: string, contextWindow?: number, maxTokens?: number, inputModalities?: ReadonlyArray<'text'|'image'> }>} bundledCatalog
 *   the versioned, offline catalog; `source` fields live in `lib/catalog.js`
 * @property {(route: ResolvedRoute) => { url: string, headers: Record<string,string>, body: string }} buildRequest
 *   `options`, `apiKey`, `stream`, `route` are passed as a single object argument
 * @property {(payload: unknown) => { text: string, reasoning: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, finishReason: string | undefined, usage?: TokenUsage }} parseReply
 * @property {(payload: unknown) => { deltas: Array<{ kind: 'text' | 'reasoning' | 'tool-call', index?: number, id?: string, name?: string, text?: string }>, finishReason?: string, usage?: TokenUsage, requestId?: string }} parseStreamFrame
 * @property {(status: number, payload: unknown, headers: Headers) => ProtocolFailure} mapError
 * @property {(route: ResolvedRoute, model: string) => boolean} modelSupportsImages
 * @property {(route: ResolvedRoute, model: string) => { visualTokens: number, text: string } | undefined} [priceImageRequest]
 * @property {(route: ResolvedRoute, apiKey: string | undefined, signal?: AbortSignal) => Promise<ProbeResult>} probe
 * @property {(route: ResolvedRoute, apiKey: string | undefined, signal?: AbortSignal) => Promise<{ supported: boolean, models?: unknown[], notice?: string }>} [listEndpointModels]
 */

/** Provider-neutral stable failure codes this bundle can emit. */
export const FAILURE_CODES = Object.freeze({
  NO_ADAPTER: 'NO_ADAPTER',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  INVALID_CREDENTIAL: 'INVALID_CREDENTIAL',
  AUTH: 'AUTH',
  RATE_LIMIT: 'RATE_LIMIT',
  QUOTA: 'QUOTA',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_CONTENT: 'UNSUPPORTED_CONTENT',
  UNSUPPORTED_REASONING_EFFORT: 'UNSUPPORTED_REASONING_EFFORT',
  SERVER: 'SERVER',
  TRANSPORT: 'TRANSPORT',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  STREAM_CLOSED: 'STREAM_CLOSED',
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  INVALID_CONFIG: 'INVALID_CONFIG',
})

/** Reasoning effort levels this bundle accepts, weakest first. */
export const REASONING_EFFORTS = Object.freeze(['off', 'low', 'high', 'max'])

/** Failure codes `dsh-llm-retry` treats as worth retrying, per route. */
export const RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * Build an `Error` carrying a stable provider-neutral code, plus the optional
 * serializable provider facts the harness forwards into `LlmFailure`.
 *
 * @param {string} code
 * @param {string} message
 * @param {{ status?: number, providerRetryAfterMs?: number, requestId?: string, cause?: unknown }} [facts]
 */
export function failure(code, message, facts = {}) {
  const error = new Error(message, facts.cause === undefined ? undefined : { cause: facts.cause })
  error.code = code
  if (facts.status !== undefined) error.status = facts.status
  if (facts.providerRetryAfterMs !== undefined) error.providerRetryAfterMs = facts.providerRetryAfterMs
  if (facts.requestId !== undefined) error.requestId = facts.requestId
  return error
}

/** Read the stable code off any thrown value. */
export function codeOf(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code
  return typeof code === 'string' && code.length > 0 ? code : 'SERVER'
}
