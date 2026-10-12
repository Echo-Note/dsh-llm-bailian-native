/**
 * Client half of the bundle: the "百炼用量与价格" settings page.
 *
 * Plain JavaScript, loaded as a browser bundle (`window.__ModuleLoader__.load`),
 * exactly like the shipped decorations and like other third-party settings pages
 * (cost-meter, skills-manager, prompt-optimizer all register here).
 *
 * Two rules shape this file:
 *
 * 1. **No Harness Client package is imported.** Only `react` comes from the
 *    browser module table; the page renders `React.createElement` directly and
 *    styles itself exclusively with `--dsw-alias-*` theme tokens, so a renamed
 *    token can only degrade appearance, never break rendering.
 * 2. **It degrades instead of throwing.** A page whose data cannot be read must
 *    still render an explanation: a throwing component blanks the whole slot
 *    entry (`slot entry crashed in '<slot>'`).
 *
 * The configuration it shows is the same `providers.<route>` section the Models
 * page edits, read through the standard `settings` remote — so this page is a
 * view over the plugin's own stored configuration, not a second source of truth.
 *
 * @module @local/dsh-llm-bailian-native/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-llm-bailian-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * The client context captured in apply(). The slot component is rendered by
     * the host shell, not by this module, so the only reliable way to reach the
     * plugin's own context is to keep it here.
     */
    let clientCtx = null

    /** The settings namespace this plugin's row owns (its Loader entry id). */
    const SETTINGS_NS = 'llm-bailian-native'
    /** The route inside it. */
    const ROUTE = 'bailian-native'
    /** The settings path the Models page writes. */
    const SETTINGS_PATH = ['providers', ROUTE]

    /** The published implicit-cache rule, mirrored for the preview arithmetic. */
    const IMPLICIT_CACHE_HIT_RATIO = 0.2

    const css = `
.bln-page{display:flex;flex-direction:column;gap:14px;padding:14px 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.bln-h{font-size:14px;font-weight:600;margin:0}
.bln-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.bln-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.bln-muted{color:var(--dsw-alias-label-secondary)}
.bln-warn{color:var(--dsw-alias-state-warning-primary)}
.bln-ok{color:var(--dsw-alias-state-business-primary)}
.bln-grid{display:grid;grid-template-columns:minmax(120px,auto) 1fr;gap:4px 14px}
.bln-k{color:var(--dsw-alias-label-secondary)}
.bln-v{overflow-wrap:anywhere}
.bln-row{display:grid;grid-template-columns:1fr auto auto auto auto;gap:8px;align-items:center;padding:3px 0;border-top:1px solid var(--dsw-alias-border-secondary)}
.bln-row:first-child{border-top:0}
.bln-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.bln-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.bln-stat{border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;padding:8px 10px}
.bln-stat-v{font-size:16px;font-weight:600}
.bln-tag{display:inline-block;border:1px solid var(--dsw-alias-border-secondary);border-radius:999px;padding:0 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.bln-list{margin:6px 0 0;padding-left:18px}
.bln-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.bln-btn{background:transparent;border:1px solid var(--dsw-alias-border-secondary);border-radius:6px;color:var(--dsw-alias-label-primary);padding:3px 10px;cursor:pointer;font-size:12px}
.bln-btn[aria-busy="true"]{opacity:.6;cursor:default}
`

    /**
     * Read the plugin's own settings section.
     *
     * Returns a discriminated result rather than throwing so the caller can
     * render "unavailable" with the reason instead of crashing the slot.
     * @param {any} ctx
     */
    /**
     * Resolve the settings facade the Models page itself uses.
     *
     * The client Service catalog does not expose `settings`: the browser reaches
     * it as a **Typert remote** (`ctx.remote.settings`, declared by the page
     * plugin's own `inject`), which is why `ctx.get('settings')` alone finds
     * nothing. Several shapes are probed so a different deployment still works.
     *
     * @param {any} ctx
     */
    function settingsFacade(ctx) {
      const candidates = []
      if (ctx?.remote !== undefined && ctx.remote !== null) {
        if (ctx.remote.settings !== undefined) candidates.push(['ctx.remote.settings', ctx.remote.settings])
        if (typeof ctx.remote.$get === 'function') {
          try {
            const via = ctx.remote.$get('settings')
            if (via !== undefined) candidates.push(["ctx.remote.$get('settings')", via])
          } catch { /* probing only */ }
        }
      }
      if (typeof ctx?.get === 'function') {
        for (const key of ['remote.settings', 'settings', 'configForms']) {
          try {
            const value = ctx.get(key)
            if (value !== undefined) candidates.push([`ctx.get('${key}')`, value])
          } catch { /* probing only */ }
        }
      }
      for (const [label, facade] of candidates) {
        if (facade !== null && typeof facade === 'object' && typeof facade.describe === 'function') {
          return { kind: 'ok', facade, label }
        }
      }
      return { kind: 'missing', probed: candidates.map(([label]) => label) }
    }

    /**
     * Read the plugin's own settings section.
     *
     * Returns a discriminated result rather than throwing so the caller can
     * render "unavailable" with the reason instead of crashing the slot.
     * @param {any} ctx
     */
    async function readConfig(ctx) {
      const resolved = settingsFacade(ctx)
      if (resolved.kind === 'missing') {
        const available = typeof ctx?.get === 'function'
          ? ['layout', 'locale', 'sessions', 'slots', 'theme', 'timer', 'uiWorkspace', 'workspaces']
              .filter((key) => { try { return ctx.get(key) !== undefined } catch { return false } })
          : []
        return {
          kind: 'unavailable',
          reason: resolved.probed.length === 0
            ? 'the settings service is not reachable from this plugin (no ctx.remote.settings and no client settings service)'
            : `the settings service was found in none of ${resolved.probed.join(', ')}`,
          detail: available.length > 0 ? `client services visible here: ${available.join(', ')}` : null,
        }
      }
      let descriptors
      try {
        descriptors = await resolved.facade.describe()
      } catch (error) {
        return { kind: 'unavailable', reason: `reading settings through ${resolved.label} failed: ${error?.message ?? String(error)}` }
      }
      // A remote answers a RemoteResult envelope; a direct service answers the array.
      const list = Array.isArray(descriptors)
        ? descriptors
        : Array.isArray(descriptors?.value)
          ? descriptors.value
          : null
      if (list === null) {
        return { kind: 'unavailable', reason: `${resolved.label}.describe() did not return a descriptor list` }
      }
      const descriptor = list.find((entry) => entry?.ns === SETTINGS_NS)
      if (descriptor === undefined) {
        return {
          kind: 'unconfigured',
          reason: `no settings section is registered under "${SETTINGS_NS}" yet`,
          detail: list.length > 0 ? `${list.length} sections are registered` : null,
        }
      }
      const pick = (root) => {
        let node = root
        for (const segment of SETTINGS_PATH) {
          if (node === null || typeof node !== 'object') return undefined
          node = node[segment]
        }
        return node
      }
      // `user` is the layer the Models page writes; `value` is the resolved view.
      const profile = pick(descriptor.user) ?? pick(descriptor.value)
      if (profile === null || typeof profile !== 'object') {
        return { kind: 'unconfigured', reason: `"${SETTINGS_PATH.join('.')}" is not configured yet` }
      }
      return { kind: 'ok', profile, descriptor, via: resolved.label }
    }

    /** @param {string} value */
    function money(value, currency) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
      const digits = value > 0 && value < 0.0001 ? 8 : 6
      return `${symbol}${value.toFixed(digits)}`
    }

    /** @param {number} value */
    function percent(value) {
      return `${value.toFixed(1)}%`
    }

    /**
     * Local price for one catalog entry, mirroring the host's precedence:
     * configured override → bundled table is host-side only, so an override is
     * what this page can see; without one it reports "host default".
     */
    function priceRow(profile, model) {
      const overrides = profile?.pricing?.models ?? {}
      const row = overrides?.[model] ?? null
      return {
        model,
        cacheMiss: typeof row?.cacheMiss === 'number' ? row.cacheMiss : null,
        cacheHit: typeof row?.cacheHit === 'number' ? row.cacheHit : null,
        output: typeof row?.output === 'number' ? row.output : null,
        currency: row?.currency ?? profile?.pricing?.currency ?? 'CNY',
        source: row?.source ?? null,
        verified: row?.verified !== false,
        overridden: row !== null,
      }
    }

    /** @param {any} saved */
    function ConnectionCard({ saved }) {
      const rows = [
        ['显示名称', saved?.displayName ?? '阿里云百炼（原生协议）'],
        ['协议', saved?.protocol ?? 'dashscope-native'],
        ['服务地址', saved?.baseURL ?? '（未配置，使用内置默认值）'],
        ['凭据引用', saved?.apiKeyEnv ?? '（未配置）'],
        ['默认模型', saved?.defaultModel ?? '—'],
        ['原生子路径', saved?.generationPath ?? 'auto'],
      ]
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 'title' }, h('h3', { className: 'bln-h' }, '连接')),
        h('div', { className: 'bln-grid', key: 'rows' }, rows.flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v bln-mono', key: `${k}-v` }, String(v)),
        ])),
        h('p', { className: 'bln-muted', key: 'note', style: { marginBottom: 0 } },
          '这里展示的是你在「设置 → 模型」里保存的同一段配置；密钥本身不存在配置里，只存引用名。'),
      ])
    }

    /** @param {{ profile: any }} props */
    function PricingCard({ profile }) {
      const models = Array.isArray(profile?.models) ? profile.models : []
      const disabled = new Set(Array.isArray(profile?.modelDisabled) ? profile.modelDisabled : [])
      const overrides = profile?.pricing?.models ?? {}
      const overrideIds = Object.keys(overrides)
      const preview = overrideIds.length > 0 ? overrideIds : []
      const currency = profile?.pricing?.currency ?? 'CNY'

      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '价格表覆盖'),
          h('span', { className: 'bln-tag', key: 'c' }, `币种 ${currency}`),
        ]),
        preview.length === 0
          ? h('p', { className: 'bln-muted', key: 'empty', style: { margin: 0 } },
              '尚未覆盖任何模型价格，本地计费使用插件内置价目表（含 source / sourceUrl / checkedAt，可用「模型」页的 pricing.models 逐项覆盖）。')
          : h('div', { key: 'rows' }, preview.map((model) => {
              const row = priceRow(profile, model)
              return h('div', { className: 'bln-row', key: model }, [
                h('span', { className: 'bln-mono', key: 'm' }, model),
                h('span', { key: 'in' }, `未缓存 ${row.cacheMiss ?? '—'}`),
                h('span', { key: 'hit' }, `命中 ${row.cacheHit ?? '未公布'}`),
                h('span', { key: 'out' }, `输出 ${row.output ?? '—'}`),
                h('span', { className: 'bln-tag', key: 's' }, row.source ?? 'user'),
              ])
            })),
        h('p', { className: 'bln-muted', key: 'cat', style: { marginBottom: 0 } },
          `目录 ${models.length} 个模型（停用 ${disabled.size} 个）。单价单位：每 100 万 token。`),
      ])
    }

    /** @param {{ profile: any }} props */
    function CacheCard({ profile }) {
      const overrides = profile?.pricing?.models ?? {}
      const currency = profile?.pricing?.currency ?? 'CNY'
      const sampleModel = profile?.defaultModel ?? Object.keys(overrides)[0] ?? null
      const row = sampleModel === null ? null : priceRow(profile, sampleModel)
      const published = row !== null && typeof row.cacheHit === 'number' && row.cacheHit > 0
      const miss = row?.cacheMiss ?? null
      // Mirrors the host's rule: an unpublished cache price is derived from the
      // implicit 20% rule and flagged approximate; it is never treated as free.
      const hit = published ? row.cacheHit : typeof miss === 'number' ? Math.round(miss * IMPLICIT_CACHE_HIT_RATIO * 1e6) / 1e6 : null

      // A request whose prompt is 1231 tokens with 1024 served from cache — the
      // ratio measured on a live request, kept here so the saving is concrete.
      const prompt = 1231
      const cached = 1024
      const cold = typeof miss === 'number' ? (prompt * miss) / 1e6 : null
      const warm = typeof miss === 'number' && hit !== null ? ((prompt - cached) * miss + cached * hit) / 1e6 : null
      const savedPercent = cold !== null && warm !== null && cold > 0 ? Math.round((1 - warm / cold) * 1000) / 10 : null

      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '缓存收益（省钱的主杠杆）'),
          h('span', { className: hit !== null && !published ? 'bln-tag bln-warn' : 'bln-tag', key: 'tag' },
            published ? '官方已公布缓存价' : '缓存价未公布 → 按隐式 20% 推导'),
        ]),
        row === null
          ? h('p', { className: 'bln-muted', key: 'none', style: { margin: 0 } },
              '内部价目表与默认模型由宿主侧解析；此处展示的是可覆盖的模型。可在「模型」页为某个模型覆盖价格后回到本页查看。')
          : h('div', { className: 'bln-cols', key: 'stats' }, [
              h('div', { className: 'bln-stat', key: 'cold' }, [
                h('div', { className: 'bln-muted', key: 'l' }, `未命中缓存（${prompt} 输入）`),
                h('div', { className: 'bln-stat-v', key: 'v' }, cold === null ? '—' : money(cold, currency)),
              ]),
              h('div', { className: 'bln-stat', key: 'warm' }, [
                h('div', { className: 'bln-muted', key: 'l' }, `命中缓存（${cached} 来自缓存）`),
                h('div', { className: 'bln-stat-v bln-ok', key: 'v' }, warm === null ? '—' : money(warm, currency)),
              ]),
              h('div', { className: 'bln-stat', key: 'saved' }, [
                h('div', { className: 'bln-muted', key: 'l' }, '节省'),
                h('div', { className: 'bln-stat-v', key: 'v' }, savedPercent === null ? '—' : percent(savedPercent)),
              ]),
            ]),
        h('ul', { className: 'bln-list', key: 'rules' }, [
          h('li', { key: 'r1' }, '口径：未缓存输入 = inputTokens − cacheReadTokens；命中部分按缓存价计费（两侧都按总量收会把命中 token 重复计费）。'),
          h('li', { key: 'r2' }, '官方规则：显式缓存写入 125%、显式命中 10%、隐式命中 20%。'),
          h('li', { key: 'r3' }, '例外：qwen3.8-max / qwen3.8-flash 的缓存命中价官方明确排除上述规则，此处按隐式 20% 保守推导并标为近似。'),
          h('li', { key: 'r4' }, '缓存在百炼侧自动生效，无需请求标记；命中量由网关在 usage.cached_tokens 回报。'),
        ]),
      ])
    }

    function CatalogCard({ profile }) {
      const disabled = Array.isArray(profile?.modelDisabled) ? profile.modelDisabled : []
      const models = Array.isArray(profile?.models) ? profile.models : []
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, h('h3', { className: 'bln-h' }, '模型目录')),
        h('div', { className: 'bln-grid', key: 'g' }, [
          h('div', { className: 'bln-k', key: 'k1' }, '配置的模型数'),
          h('div', { className: 'bln-v', key: 'v1' }, String(models.length)),
          h('div', { className: 'bln-k', key: 'k2' }, '停用'),
          h('div', { className: 'bln-v', key: 'v2' }, disabled.length === 0 ? '无' : disabled.join('、')),
        ]),
        h('p', { className: 'bln-muted', key: 'note', style: { marginBottom: 0 } },
          '目录刷新与「获取可用模型」在「设置 → 模型」里该提供商的卡片上完成（走 llm/discoverModels）。刷新成功后模型清单会合并进模型选择器。'),
      ])
    }

    /** @param {{ references: any }} props */
    function BillingCard({ references }) {
      const rows = [
        ['AccessKey ID 引用名', references?.accessKeyId ?? '（未配置）'],
        ['AccessKey Secret 引用名', references?.accessKeySecret ?? '（未配置）'],
      ]
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '账单对账'),
          h('span', { className: 'bln-tag bln-warn', key: 'tag' }, '需要独立的 AccessKey'),
        ]),
        h('div', { className: 'bln-grid', key: 'g' }, rows.flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v bln-mono', key: `${k}-v` }, String(v)),
        ])),
        h('p', { key: 'why', style: { marginTop: 8 } }, [
          '模型 API Key ',
          h('span', { className: 'bln-code', key: 'c' }, 'sk-…'),
          ' 无法查询账单：账单属于阿里云管控面 OpenAPI（',
          h('span', { className: 'bln-code', key: 'c2' }, 'modelstudio.<region>.aliyuncs.com'),
          '），用 AccessKey 做 ACS3-HMAC-SHA256 签名鉴权。实测把模型 Key 当 AccessKey 或用 Bearer 发送，网关分别回 ',
          h('span', { className: 'bln-code', key: 'c3' }, 'InvalidAccessKeyId.NotFound'),
          ' 与 ',
          h('span', { className: 'bln-code', key: 'c4' }, 'MissingAccessKeyId'),
          '（与完全不带鉴权头时的响应逐字相同，即网关忽略该 Key）。',
        ]),
        h('p', { className: 'bln-muted', key: 'how', style: { marginBottom: 0 } },
          '建议：建一个 RAM 子账号只授账单只读权限，把 AK/SK 存进凭据 seam，然后在这里填两个引用名。配置后可按 BASE_MODEL 维度把「本地估算」与「实际计费」对账。'),
      ])
    }

    function Unavailable({ reason, kind, detail }) {
      return h('div', { className: 'bln-card' }, [
        h('h3', { className: 'bln-h', key: 'h' }, kind === 'unconfigured' ? '尚未配置该提供商' : '暂时无法读取配置'),
        h('p', { className: 'bln-muted', key: 'p', style: { marginBottom: 0 } }, reason),
        detail === null || detail === undefined
          ? null
          : h('p', { className: 'bln-muted bln-mono', key: 'd', style: { marginBottom: 0 } }, detail),
        kind === 'unconfigured'
          ? h('p', { className: 'bln-muted', key: 'hint', style: { marginBottom: 0 } },
              '请到「设置 → 模型」添加该提供商、填入服务地址并选择凭据引用，然后回到本页。')
          : null,
      ])
    }

    function BailianPage() {
      const [state, setState] = React.useState({ status: 'loading' })

      React.useEffect(() => {
        let alive = true
        const ctx = clientCtx
        if (ctx === null) {
          setState({ status: 'ready', kind: 'unavailable', reason: 'this page was registered without a client context' })
          return () => { alive = false }
        }
        readConfig(ctx).then((result) => {
          if (alive) setState({ ...result, status: 'ready' })
        }, (error) => {
          if (alive) setState({ status: 'ready', kind: 'unavailable', reason: `reading settings failed: ${error?.message ?? String(error)}` })
        })
        return () => { alive = false }
      }, [])

      if (state.status === 'loading') {
        return h('div', { className: 'bln-page' }, h('p', { className: 'bln-muted' }, '读取配置中…'))
      }
      if (state.kind !== 'ok') {
        return h('div', { className: 'bln-page' }, h(Unavailable, { reason: state.reason, kind: state.kind, detail: state.detail }))
      }

      const profile = state.profile
      return h('div', { className: 'bln-page' }, [
        h('div', { key: 'head' }, [
          h('h2', { className: 'bln-h', style: { fontSize: 16 } }, '百炼用量与价格'),
          h('p', { className: 'bln-muted', style: { margin: '4px 0 0' } },
            '只读视图：展示该提供商已保存的配置、价格覆盖与缓存计费口径。修改配置请到「设置 → 模型」。'),
        ]),
        h(ConnectionCard, { key: 'conn', saved: profile }),
        h(CacheCard, { key: 'cache', profile }),
        h(PricingCard, { key: 'pricing', profile }),
        h(CatalogCard, { key: 'catalog', profile }),
        h(BillingCard, { key: 'billing', references: null }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Styles are registered as an effect so unmounting removes them.
        // `styles` is a module-loader builtin of this bundle (not a factory
        // argument); registering the sheet through an effect means unmounting
        // removes it again.
        if (typeof styles !== 'undefined' && typeof styles.insert === 'function') {
          ctx.effect(() => styles.insert(css), 'llm-bailian-native: styles')
        }
        clientCtx = ctx
        // The settings shell reads `label` for the nav row and `id` as the
        // section key; `order` positions it next to the other cost views.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'llm-bailian-native-usage',
          order: 35,
          label: () => '百炼用量与价格',
        }, BailianPage))
      },
    }
  },
})
