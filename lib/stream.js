/**
 * Native request execution and SSE → harness chunk translation.
 *
 * This module owns the stream contract, isolated from every DSH dependency so
 * the wire layer stays testable offline (`tests/native-stream.test.mjs` drives it
 * against a synthetic `Response`):
 *
 * - token-level deltas, one `block-start` before a block's first delta;
 * - `usage` strictly before `finish`;
 * - **exactly one** terminal `finish`, and nothing after it.
 *
 * @module @local/dsh-llm-bailian-native/stream
 */

import { FAILURE_CODES, RETRYABLE_CODES, failure } from './protocol.js'

/** @typedef {{ id: string, name: string, arguments: string, emitted: string, blockIndex?: number, nameSent: boolean }} ToolCallState */

/**
 * Translate a native SSE response body into harness chunks.
 *
 * Handles DashScope's two documented stream modes: `incremental_output: true`
 * (frames carry only new text) and `false` (frames carry the whole text so far).
 * Deltas are emitted by diffing against what has already been sent, so a
 * provider or gateway that ignores the flag cannot duplicate text in the
 * transcript.
 *
 * @param {object} input
 * @param {ReadableStream<Uint8Array>} input.body
 * @param {import('./protocol.js').ProtocolAdapter} input.adapter
 * @param {import('./protocol.js').ResolvedRoute} input.route
 * @param {AbortSignal} [input.signal]
 * @param {AbortController} [input.controller] controller to abort on idle timeout
 * @yields {import('./protocol.js').StreamChunk}
 */
export async function* translateNativeStream({ body, adapter, route, signal, controller }) {
  /** @type {Map<number, ToolCallState>} */
  const toolCalls = new Map()
  let textIndex = -1
  let reasoningIndex = -1
  let nextIndex = 0
  let emittedText = ''
  let emittedReasoning = ''
  /** @type {string | undefined} */
  let finishReason
  /** @type {import('./protocol.js').TokenUsage | undefined} */
  let usage
  /** @type {import('./protocol.js').ProtocolFailure | undefined} */
  let failed
  /** @type {string | undefined} */
  let requestId
  let sawFrame = false

  const idle = idleWatchdog(route.streamIdleTimeoutMs, () => controller?.abort(new Error('idle')))

  try {
    for await (const frame of readSseFrames(body, idle.touch)) {
      if (frame === undefined) continue
      let payload
      try {
        payload = JSON.parse(frame)
      } catch {
        throw failure(FAILURE_CODES.MALFORMED_RESPONSE, 'DashScope sent an SSE frame that is not JSON')
      }
      const parsed = /** @type {any} */ (adapter.parseStreamFrame(payload))
      if (parsed.failure !== undefined) {
        failed = parsed.failure
        break
      }
      sawFrame = true
      if (typeof parsed.requestId === 'string') requestId = parsed.requestId
      if (parsed.usage !== undefined) usage = parsed.usage
      if (typeof parsed.finishReason === 'string') finishReason = parsed.finishReason

      const reasoningDelta = deltaOf(parsed.reasoning, emittedReasoning)
      if (reasoningDelta.length > 0) {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        }
        emittedReasoning += reasoningDelta
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoningDelta }
      }

      const textDelta = deltaOf(parsed.text, emittedText)
      if (textDelta.length > 0) {
        if (textIndex < 0) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        emittedText += textDelta
        yield { type: 'text-delta', index: textIndex, text: textDelta }
      }

      for (const call of parsed.toolCalls ?? []) {
        const key = Number.isInteger(call.index) ? call.index : toolCalls.size
        let state = toolCalls.get(key)
        if (state === undefined) {
          state = { id: '', name: '', arguments: '', emitted: '', nameSent: false }
          toolCalls.set(key, state)
        }
        if (typeof call.id === 'string' && call.id.length > 0) state.id = call.id
        if (typeof call.name === 'string' && call.name.length > 0) state.name = call.name
        const incoming = typeof call.arguments === 'string' ? call.arguments : ''
        state.arguments = incoming.startsWith(state.emitted) ? incoming : state.emitted + incoming
        const delta = state.arguments.slice(state.emitted.length)
        if (delta.length === 0) continue
        state.emitted = state.arguments
        if (state.blockIndex === undefined) {
          state.blockIndex = nextIndex++
          yield { type: 'block-start', index: state.blockIndex, blockType: 'tool-call' }
        }
        const sendName = !state.nameSent && state.name.length > 0
        if (sendName) state.nameSent = true
        yield {
          type: 'tool-call-delta',
          index: state.blockIndex,
          id: state.id.length > 0 ? state.id : `call_${key}`,
          ...(sendName ? { name: state.name } : {}),
          argumentsDelta: delta,
        }
      }

      if (finishReason !== undefined) break
    }
  } catch (error) {
    if (failed === undefined) failed = classifyStreamError(error, signal)
  } finally {
    idle.dispose()
  }

  if (failed !== undefined) {
    yield {
      type: 'finish',
      reason: {
        kind: failed.code === FAILURE_CODES.ABORTED ? 'aborted' : 'error',
        failure: requestId === undefined || failed.requestId !== undefined ? failed : { ...failed, requestId },
      },
    }
    return
  }
  if (signal?.aborted === true) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: FAILURE_CODES.ABORTED, message: 'the caller aborted this request' } } }
    return
  }
  if (!sawFrame) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: FAILURE_CODES.STREAM_CLOSED, message: 'DashScope closed the stream without sending a single frame' } },
    }
    return
  }

  const hasContent = emittedText.length > 0 || emittedReasoning.length > 0 || toolCalls.size > 0
  if (usage !== undefined) yield { type: 'usage', usage }

  if (!hasContent) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: FAILURE_CODES.EMPTY_RESPONSE,
          message: requestId === undefined
            ? 'DashScope finished without producing text, thinking or tool calls'
            : `DashScope finished without producing text, thinking or tool calls (request_id ${requestId})`,
          ...(requestId === undefined ? {} : { requestId }),
        },
      },
    }
    return
  }

  yield {
    type: 'finish',
    reason: { kind: finishKindOf(finishReason, toolCalls.size > 0) },
    replayState: { response: { provider: route.route, requestId, finishReason, usage } },
  }
}

/**
 * Non-streaming path: one request, one reply, replayed as delta chunks so the
 * same translator contract holds either way.
 *
 * @param {object} input
 * @param {import('./protocol.js').ProtocolAdapter} input.adapter
 * @param {import('./protocol.js').ResolvedRoute} input.route
 * @param {unknown} input.payload
 * @yields {import('./protocol.js').StreamChunk}
 */
export async function* translateNativeReply({ adapter, route, payload }) {
  const parsed = /** @type {any} */ (adapter.parseReply(payload))
  let nextIndex = 0
  let hasContent = false

  if (typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0) {
    hasContent = true
    yield { type: 'block-start', index: nextIndex, blockType: 'reasoning' }
    yield { type: 'reasoning-delta', index: nextIndex, text: parsed.reasoning }
    nextIndex += 1
  }
  if (typeof parsed.text === 'string' && parsed.text.length > 0) {
    hasContent = true
    yield { type: 'block-start', index: nextIndex, blockType: 'text' }
    yield { type: 'text-delta', index: nextIndex, text: parsed.text }
    nextIndex += 1
  }
  for (const call of parsed.toolCalls ?? []) {
    hasContent = true
    yield { type: 'block-start', index: nextIndex, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: nextIndex, id: call.id, name: call.name, argumentsDelta: call.arguments }
    nextIndex += 1
  }

  const toolCallCount = Array.isArray(parsed.toolCalls) ? parsed.toolCalls.length : 0
  if (parsed.usage !== undefined) yield { type: 'usage', usage: parsed.usage }

  if (!hasContent) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { code: FAILURE_CODES.EMPTY_RESPONSE, message: 'DashScope returned an empty completion' } },
    }
    return
  }
  yield {
    type: 'finish',
    reason: { kind: finishKindOf(parsed.finishReason, toolCallCount > 0) },
    replayState: {
      response: { provider: route.route, requestId: parsed.requestId, finishReason: parsed.finishReason, usage: parsed.usage },
    },
  }
}

/**
 * Execute one native request and translate it into harness chunks.
 *
 * Every adapter failure becomes a terminal `error`/`aborted` finish chunk, so a
 * consumer never sees a thrown transport error — that is the harness contract.
 *
 * @param {object} input
 * @param {import('./protocol.js').ProtocolAdapter} input.adapter
 * @param {import('./protocol.js').ResolvedRoute} input.route
 * @param {import('./protocol.js').GenerateOptions} input.options
 * @param {string | undefined} input.apiKey
 * @param {boolean} input.stream
 * @yields {import('./protocol.js').StreamChunk}
 */
export async function* runNativeRequest({ adapter, route, options, apiKey, stream }) {
  // A route with no resolved credential must fail as MISSING_CREDENTIAL *before*
  // any I/O. Sending an empty `Authorization` would make the provider answer 401
  // and the failure would surface as AUTH, which names the wrong thing to fix.
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: FAILURE_CODES.MISSING_CREDENTIAL,
          message: `provider route "${route.route}" has no resolved credential (apiKeyEnv ${route.apiKeyEnv ?? 'unset'}); set it through the credentials seam — the Web Models page writes it`,
        },
      },
    }
    return
  }

  /** @type {{ url: string, headers: Record<string,string>, body: string } | undefined} */
  let request
  try {
    request = adapter.buildRequest({ route, options, apiKey, stream })
  } catch (error) {
    yield { type: 'finish', reason: { kind: 'error', failure: toFailure(error) } }
    return
  }

  const controller = new AbortController()
  const release = linkAbort(options.signal, controller)
  const deadline = startDeadline(route.timeoutMs, controller)

  /** @type {Response} */
  let response
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
  } catch (error) {
    deadline.dispose()
    release()
    yield { type: 'finish', reason: { kind: 'error', failure: classifyTransportError(error, options.signal) } }
    return
  }
  deadline.dispose()

  try {
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined)
      yield { type: 'finish', reason: { kind: 'error', failure: adapter.mapError(response.status, payload, response.headers) } }
      return
    }
    if (stream) {
      if (response.body === null) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: FAILURE_CODES.STREAM_CLOSED, message: 'DashScope returned a successful response with no body' } } }
        return
      }
      yield* translateNativeStream({ body: response.body, adapter, route, signal: options.signal, controller })
      return
    }
    const payload = await response.json().catch(() => undefined)
    if (payload === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: FAILURE_CODES.MALFORMED_RESPONSE, message: 'DashScope returned a 2xx response that is not JSON' } } }
      return
    }
    const body = /** @type {Record<string, unknown>} */ (payload)
    if (typeof body.code === 'string' && body.code.length > 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: adapter.mapError(200, payload, response.headers) } }
      return
    }
    yield* translateNativeReply({ adapter, route, payload })
  } catch (error) {
    yield { type: 'finish', reason: { kind: 'error', failure: toFailure(error) } }
  } finally {
    release()
  }
}

/**
 * Parse an SSE byte stream into `data:` payloads.
 *
 * DashScope native frames additionally carry `id:`, `event: result` and a
 * `:HTTP_STATUS/200` comment line; only `data:` is payload. There is no `[DONE]`
 * sentinel documented on this surface, but one is tolerated in case a gateway
 * adds it.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {() => void} onFrame
 * @returns {AsyncGenerator<string>}
 */
export async function* readSseFrames(body, onFrame) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onFrame()
      buffer += decoder.decode(value, { stream: true })
      let boundary = findBoundary(buffer)
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const payload = dataOf(raw)
        if (payload !== undefined) yield payload
        boundary = findBoundary(buffer)
      }
    }
    buffer += decoder.decode()
    for (const raw of buffer.split(/\r?\n\r?\n/)) {
      const payload = dataOf(raw)
      if (payload !== undefined) yield payload
    }
  } finally {
    reader.releaseLock()
  }
}

/** @param {string} buffer @returns {{ index: number, length: number } | -1} */
function findBoundary(buffer) {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return -1
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 }
  return { index: lf, length: 2 }
}

/** @param {string} block @returns {string | undefined} */
function dataOf(block) {
  const payloads = []
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    payloads.push(line.slice(5).trimStart())
  }
  if (payloads.length === 0) return undefined
  const joined = payloads.join('\n')
  if (joined === '[DONE]') return undefined
  return joined.length === 0 ? undefined : joined
}

/**
 * Difference between a frame's accumulated text and what was already sent,
 * correct for both the incremental and the cumulative provider modes.
 * @param {unknown} next
 * @param {string} emitted
 */
function deltaOf(next, emitted) {
  if (typeof next !== 'string' || next.length === 0) return ''
  if (next === emitted) return ''
  if (next.startsWith(emitted)) return next.slice(emitted.length)
  return next
}

/** @param {string | undefined} finishReason @param {boolean} hasToolCalls */
function finishKindOf(finishReason, hasToolCalls) {
  if (finishReason === 'length' || finishReason === 'max_tokens') return 'max-tokens'
  if (finishReason === 'tool_calls' || hasToolCalls) return 'tool-calls'
  return 'stop'
}

/**
 * Convert any thrown value into a stable failure, preserving an existing code.
 * @param {unknown} error
 * @returns {import('./protocol.js').ProtocolFailure}
 */
export function toFailure(error) {
  const record = /** @type {{ code?: unknown, status?: unknown, requestId?: unknown }} */ (error)
  const code = typeof record?.code === 'string' && record.code.length > 0 ? record.code : FAILURE_CODES.SERVER
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    ...(typeof record?.status === 'number' ? { status: record.status } : {}),
    ...(typeof record?.requestId === 'string' ? { requestId: record.requestId } : {}),
  }
}

/** @param {unknown} error @param {AbortSignal | undefined} callerSignal */
function classifyTransportError(error, callerSignal) {
  if (callerSignal?.aborted === true) {
    return { code: FAILURE_CODES.ABORTED, message: 'the caller aborted this request' }
  }
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: FAILURE_CODES.TIMEOUT, message: 'the request exceeded its deadline or was aborted' }
  }
  const cause = /** @type {{ cause?: unknown }} */ (error)?.cause
  const detail = cause instanceof Error ? cause.message : undefined
  return {
    code: FAILURE_CODES.TRANSPORT,
    message: `could not reach DashScope: ${detail ?? (error instanceof Error ? error.message : String(error))}`,
  }
}

/** @param {unknown} error @param {AbortSignal | undefined} callerSignal */
function classifyStreamError(error, callerSignal) {
  if (error instanceof Error && typeof /** @type {{ code?: unknown }} */ (error).code === 'string') return toFailure(error)
  if (callerSignal?.aborted === true) {
    return { code: FAILURE_CODES.ABORTED, message: 'the caller aborted this request' }
  }
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError') return { code: FAILURE_CODES.TIMEOUT, message: 'the DashScope stream went idle past its budget' }
  return { code: FAILURE_CODES.TRANSPORT, message: `the DashScope stream failed: ${error instanceof Error ? error.message : String(error)}` }
}

/**
 * Forward a caller's abort to this request's controller.
 * @param {AbortSignal | undefined} caller
 * @param {AbortController} controller
 * @returns {() => void}
 */
function linkAbort(caller, controller) {
  if (caller === undefined) return () => {}
  if (caller.aborted) {
    controller.abort()
    return () => {}
  }
  const onAbort = () => controller.abort()
  caller.addEventListener('abort', onAbort, { once: true })
  return () => caller.removeEventListener('abort', onAbort)
}

/**
 * Enforce the whole-request deadline without leaking a timer.
 * @param {number} timeoutMs
 * @param {AbortController} controller
 */
function startDeadline(timeoutMs, controller) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { dispose: () => {} }
  const timer = setTimeout(() => controller.abort(new Error('deadline')), timeoutMs)
  timer.unref?.()
  return { dispose: () => clearTimeout(timer) }
}

/**
 * Idle watchdog for a stream: a provider that stops sending frames must not hang
 * the turn forever. Re-arms on every frame and aborts the request when it fires.
 * @param {number} idleMs
 * @param {() => void} onIdle
 */
function idleWatchdog(idleMs, onIdle) {
  if (!Number.isFinite(idleMs) || idleMs <= 0) return { touch: () => {}, dispose: () => {} }
  let timer
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(onIdle, idleMs)
    timer.unref?.()
  }
  arm()
  return { touch: arm, dispose: () => clearTimeout(timer) }
}

/** Codes the provider-owned retry policy should re-run. */
export const RETRYABLE = RETRYABLE_CODES
