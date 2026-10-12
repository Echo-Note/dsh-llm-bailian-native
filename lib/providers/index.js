/**
 * Protocol registry — the extension seam for additional cloud vendors.
 *
 * This release registers exactly one entry: `dashscope-native`
 * (Aliyun Bailian / 阿里云百炼, native protocol). Tencent Cloud and Baidu Cloud
 * are **not implemented**; they are declared as reserved keys below and are
 * rejected with an explanatory failure instead of a bare "unknown protocol".
 *
 * To add one later:
 *   1. create `lib/providers/<vendor>/<protocol>.js` exporting a `ProtocolAdapter`
 *      (see `lib/protocol.js` for the contract and `providers/dashscope/native.js`
 *      for a complete worked example);
 *   2. import it here and call `registerProtocol('tencent-native', adapter)`;
 *   3. add one `catalog` entry in `lib/catalog.js`.
 * No other file in the bundle needs to change.
 *
 * @module @local/dsh-llm-bailian-native/providers
 */

import { dashscopeNative } from './dashscope/native.js'

/** @type {Map<string, import('../protocol.js').ProtocolAdapter>} */
const protocols = new Map()

/**
 * Protocols reserved for future vendor adapters. Naming them here means a user
 * who configures one gets a precise, actionable diagnostic.
 * @type {ReadonlyArray<{ protocol: string, vendor: string, vendorDisplayName: string, status: 'planned' }>}
 */
export const PLANNED_PROTOCOLS = Object.freeze([
  { protocol: 'tencent-native', vendor: 'tencent', vendorDisplayName: '腾讯云', status: 'planned' },
  { protocol: 'baidu-native', vendor: 'baidu', vendorDisplayName: '百度智能云千帆', status: 'planned' },
])

/**
 * Register one wire adapter. Called once per protocol at module load.
 * @param {string} protocol
 * @param {import('../protocol.js').ProtocolAdapter} adapter
 */
export function registerProtocol(protocol, adapter) {
  if (typeof protocol !== 'string' || protocol.length === 0) throw new Error('a protocol key must be a non-empty string')
  if (protocols.has(protocol)) throw new Error(`protocol "${protocol}" is already registered`)
  if (adapter === null || typeof adapter !== 'object') throw new Error(`protocol "${protocol}" has no adapter`)
  if (adapter.protocol !== protocol) throw new Error(`protocol "${protocol}" adapter declares protocol "${adapter.protocol}"`)
  for (const required of ['buildRequest', 'parseReply', 'parseStreamFrame', 'mapError', 'probe']) {
    if (typeof adapter[required] !== 'function') throw new Error(`protocol "${protocol}" adapter is missing ${required}()`)
  }
  protocols.set(protocol, adapter)
}

/**
 * Resolve one registered protocol.
 * @param {string} protocol
 * @returns {import('../protocol.js').ProtocolAdapter}
 */
export function protocolFor(protocol) {
  const adapter = protocols.get(protocol)
  if (adapter !== undefined) return adapter
  const planned = PLANNED_PROTOCOLS.find((entry) => entry.protocol === protocol)
  if (planned !== undefined) {
    throw new Error(
      `protocol "${protocol}" (${planned.vendorDisplayName}) is a reserved integration point in this bundle but is not implemented yet; `
      + 'this release ships the Aliyun Bailian / DashScope native adapter only — add lib/providers/'
      + `${planned.vendor}/<protocol>.js and registerProtocol() to enable it`,
    )
  }
  const known = [...protocols.keys(), ...PLANNED_PROTOCOLS.map((entry) => entry.protocol)].join(', ')
  throw new Error(`unknown protocol "${protocol}"; this bundle knows: ${known}`)
}

/** Every protocol that can currently serve a route, in registration order. */
export function registeredProtocols() {
  return [...protocols.keys()]
}

registerProtocol('dashscope-native', dashscopeNative)
