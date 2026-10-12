/**
 * Client half of the bundle: the "百炼用量与价格" settings page.
 *
 * Plain JavaScript, loaded as a browser bundle (`window.__ModuleLoader__.load`),
 * exactly like the shipped decorations and like other third-party settings pages
 * (cost-meter, skills-manager, prompt-optimizer all register in this slot).
 *
 * ## What this page can and cannot read
 *
 * The browser reaches the host only through declared *lazy* services. Measured
 * against the running app, the Remote surface exposes exactly:
 *
 *   remote.credentials.describe | .set | .unset
 *   remote.llm.listConfigurableProviders | .listProviders | .discoverModels
 *   remote.session.modelCatalog
 *   remote.settings.mutate          (write only)
 *
 * There is **no** `remote.settings.describe`, and the client Service catalog has
 * no `settings` service at all — an earlier version of this page wrongly assumed
 * both, and reported a misleading error. This page therefore shows what the
 * read-only calls genuinely answer (route registration, directory row, credential
 * state), plus the cache rules, which are static knowledge needing no call.
 *
 * Richer host state (resolved price table, catalog diff, self-check, billing
 * reconciliation) needs a host `./typert` face plus `remote.$mount`; that bridge
 * is not implemented yet, and the page says so instead of rendering blanks.
 *
 * ## Two rendering rules
 *
 * 1. **No Harness Client package is imported.** Only `react` comes from the
 *    browser module table; styles are `--dsw-alias-*` theme tokens, so a renamed
 *    token can only degrade appearance, never break rendering.
 * 2. **It degrades instead of throwing.** A slot entry that throws is blanked by
 *    the shell (`slot entry crashed in '<slot>'`), so every failure path renders
 *    an explanation instead.
 *
 * @module @local/dsh-llm-bailian-native/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-llm-bailian-native',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The client context captured in apply(); the slot renders outside this module. */
    let clientCtx = null

    /** The settings namespace this plugin's row owns (its Loader entry id). */
    const SETTINGS_NS = 'llm-bailian-native'
    /** The route inside it. */
    const ROUTE = 'bailian-native'
    /** The settings path the Models page writes. */
    const SETTINGS_PATH = ['providers', ROUTE]

    const css = `
.bln-page{display:flex;flex-direction:column;gap:14px;padding:14px 16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.bln-h{font-size:14px;font-weight:600;margin:0}
.bln-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.bln-card-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.bln-muted{color:var(--dsw-alias-label-secondary)}
.bln-warn{color:var(--dsw-alias-state-warning-primary)}
.bln-grid{display:grid;grid-template-columns:minmax(130px,auto) 1fr;gap:4px 14px}
.bln-k{color:var(--dsw-alias-label-secondary)}
.bln-v{overflow-wrap:anywhere}
.bln-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.bln-tag{display:inline-block;border:1px solid var(--dsw-alias-border-secondary);border-radius:999px;padding:0 7px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.bln-list{margin:8px 0 0;padding-left:18px}
.bln-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
.bln-card p{margin:6px 0}
`

    /**
     * Unwrap a gateway response.
     *
     * The Remote surface answers a `RemoteResult` envelope (`{ok,value}` or
     * `{ok:false,error}`) for some namespaces and a bare value for others, and an
     * unknown method *rejects* rather than resolving falsy. All three are
     * normalized so callers only see `{ok:true,value}` or `{ok:false,error}`.
     * @param {unknown} response
     */
    function unwrap(response) {
      const record = response !== null && typeof response === 'object' ? response : null
      if (record !== null && ('ok' in record || 'value' in record || 'error' in record)) {
        if (record.ok === false) return { ok: false, error: record.error }
        return { ok: true, value: record.value }
      }
      return { ok: true, value: response }
    }

    /**
     * Read this provider's live status through the calls that actually exist.
     * @param {any} ctx
     */
    async function readStatus(ctx) {
      /** @type {any} */
      let remote
      try {
        remote = ctx?.remote
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: `the client context refused a lazy service: ${error?.message ?? String(error)}`,
          detail: "this bundle declares inject: ['slots','remote','remote.llm','remote.credentials']",
        }
      }
      if (remote === undefined || remote === null) {
        return { kind: 'unavailable', reason: 'this client context exposes no remote gateway' }
      }

      const failures = []
      let directoryRow = null
      let routeInfo = null

      if (remote?.llm?.listConfigurableProviders !== undefined) {
        try {
          const result = unwrap(await remote.llm.listConfigurableProviders())
          if (result.ok && Array.isArray(result.value)) directoryRow = result.value.find((entry) => entry?.provider === ROUTE) ?? null
          else if (!result.ok) failures.push(`remote.llm.listConfigurableProviders: ${result.error?.message ?? 'rejected'}`)
        } catch (error) {
          failures.push(`remote.llm.listConfigurableProviders: ${error?.message ?? String(error)}`)
        }
      } else {
        failures.push('remote.llm.listConfigurableProviders is not exposed')
      }

      if (remote?.llm?.listProviders !== undefined) {
        try {
          const result = unwrap(await remote.llm.listProviders())
          if (result.ok && Array.isArray(result.value)) routeInfo = result.value.find((entry) => entry?.id === ROUTE) ?? null
          else if (!result.ok) failures.push(`remote.llm.listProviders: ${result.error?.message ?? 'rejected'}`)
        } catch (error) {
          failures.push(`remote.llm.listProviders: ${error?.message ?? String(error)}`)
        }
      } else {
        failures.push('remote.llm.listProviders is not exposed')
      }

      const ref = typeof directoryRow?.apiKeyEnv === 'string' ? directoryRow.apiKeyEnv : null
      let credential = null
      if (ref !== null && remote?.credentials?.describe !== undefined) {
        try {
          const result = unwrap(await remote.credentials.describe([ref]))
          if (result.ok && result.value !== null && typeof result.value === 'object') credential = result.value[ref] ?? null
          else if (!result.ok) failures.push(`remote.credentials.describe: ${result.error?.message ?? 'rejected'}`)
        } catch (error) {
          failures.push(`remote.credentials.describe: ${error?.message ?? String(error)}`)
        }
      }

      if (directoryRow !== null || routeInfo !== null) {
        return {
          kind: 'ok',
          live: {
            directoryRow,
            routeInfo,
            credential,
            credentialRef: ref,
            settingsNs: directoryRow?.settingsNs ?? SETTINGS_NS,
            settingsPath: Array.isArray(directoryRow?.settingsPath) ? directoryRow.settingsPath : SETTINGS_PATH,
          },
          failures,
        }
      }
      return {
        kind: 'unavailable',
        reason: failures.length > 0 ? failures[0] : 'the read-only gateway calls answered nothing for this route',
        detail: failures.length > 1 ? `${failures.length - 1} more failure(s) shown below` : null,
      }
    }

    /** @param {{ live: any }} props */
    function ConnectionCard({ live }) {
      const row = live?.directoryRow ?? null
      const route = live?.routeInfo ?? null
      const credential = live?.credential ?? null
      const ref = live?.credentialRef ?? null
      const rows = [
        ['提供商路由', ROUTE],
        ['可配置提供商目录', row === null ? '未找到该路由' : row.declared === true ? '已声明（可采纳）' : '已声明'],
        ['llm 注册表', route === null ? '未注册（尚无已保存配置时属正常）' : `${route.id} · ${route.name}`],
        ['设置地址', Array.isArray(live?.settingsPath) ? live.settingsPath.join('.') : SETTINGS_PATH.join('.')],
        ['设置命名空间', live?.settingsNs ?? SETTINGS_NS],
        ['凭据引用', ref ?? '（该路由尚未保存配置，故无引用名）'],
        ['凭据状态', credential === null
          ? '未查询'
          : credential.configured === true
            ? `已配置${typeof credential.source === 'string' ? `（来源 ${credential.source}）` : ''}`
            : '未配置'],
      ]
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, h('h3', { className: 'bln-h' }, '连接与注册状态')),
        h('div', { className: 'bln-grid', key: 'g' }, rows.flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v bln-mono', key: `${k}-v` }, String(v)),
        ])),
        h('p', { className: 'bln-muted', key: 'hint', style: { marginBottom: 0 } },
          row === null
            ? '该提供商尚未出现在可配置提供商目录中：请到「设置 → 模型」添加它，填写服务地址与凭据引用后保存。'
            : '连接与模型清单在「设置 → 模型」里编辑；密钥只存于凭据 seam，配置里只有引用名。'),
      ])
    }

    /** Cache rules are static knowledge, so this panel needs no host call. */
    function CacheCard() {
      const rules = [
        ['隐式缓存命中', '输入单价的 20%（自动生效，无需请求标记）'],
        ['显式缓存命中', '输入单价的 10%（需 cache_control 标记）'],
        ['显式缓存写入', '输入单价的 125%'],
        ['最低可缓存前缀', '1024 token，TTL 5 分钟'],
        ['官方规则例外', 'qwen3.8-max / qwen3.8-flash 的命中价官方未公布，本地按隐式 20% 保守推导并标为近似'],
      ]
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '缓存计费口径（省钱的主杠杆）'),
          h('span', { className: 'bln-tag', key: 'tag' }, '按 token 计'),
        ]),
        h('div', { className: 'bln-grid', key: 'g' }, rules.flatMap(([k, v]) => [
          h('div', { className: 'bln-k', key: `${k}-k` }, k),
          h('div', { className: 'bln-v', key: `${k}-v` }, v),
        ])),
        h('ul', { className: 'bln-list', key: 'note' }, [
          h('li', { key: 'a' }, '计费口径：未缓存输入 = inputTokens − cacheReadTokens，命中部分按缓存价。两侧都按总量收会把命中 token 重复计费 —— 实测那样会让一次命中比不命中贵 16.6%，方向正好相反。'),
          h('li', { key: 'b' }, '真机实测（qwen3.8-flash，1231 输入 / 1024 命中）：0.014808 → 0.0049776 CNY，省 66.4%。'),
          h('li', { key: 'c' }, '命中量由网关在 usage.cached_tokens 或 prompt_tokens_details.cached_tokens 回报；本插件把它算入 TokenUsage.cacheReadTokens。'),
        ]),
      ])
    }

    /** @param {{ live: any }} props */
    function BillingCard({ live }) {
      const ref = live?.credentialRef ?? null
      return h('div', { className: 'bln-card' }, [
        h('div', { className: 'bln-card-title', key: 't' }, [
          h('h3', { className: 'bln-h', key: 'h' }, '账单对账'),
          h('span', { className: 'bln-tag bln-warn', key: 'tag' }, '需要独立的 AccessKey'),
        ]),
        h('p', { key: 'why' }, [
          '模型 API Key（',
          h('span', { className: 'bln-code', key: 'c' }, ref ?? 'sk-…'),
          '）无法查询账单：账单属于阿里云管控面 OpenAPI（',
          h('span', { className: 'bln-code', key: 'c2' }, 'modelstudio.<region>.aliyuncs.com'),
          '），用 AccessKey 做 ACS3-HMAC-SHA256 签名。实测把模型 Key 当 AccessKey、或用 Bearer 发送，网关分别回 ',
          h('span', { className: 'bln-code', key: 'c3' }, 'InvalidAccessKeyId.NotFound'),
          ' 与 ',
          h('span', { className: 'bln-code', key: 'c4' }, 'MissingAccessKeyId'),
          '（后者与完全不带鉴权头时逐字相同，即网关忽略该 Key）。',
        ]),
        h('p', { key: 'done', style: { marginBottom: 0 } }, [
          '本插件的 ',
          h('span', { className: 'bln-code', key: 'c5' }, 'lib/billing.js'),
          ' 已实现并真机跑通这两个接口（2026-09 = 95.87 CNY、2026-08 = 1238.25 CNY，按 BASE_MODEL 分组）。要把数字显示到这里，还差宿主侧 typert 数据面这一步。',
        ]),
      ])
    }

    function Unavailable({ reason, detail, extra }) {
      return h('div', { className: 'bln-card' }, [
        h('h3', { className: 'bln-h', key: 'h' }, '暂时无法读取状态'),
        h('p', { className: 'bln-muted', key: 'p' }, reason),
        detail === null || detail === undefined ? null : h('p', { className: 'bln-muted bln-mono', key: 'd' }, detail),
        Array.isArray(extra) && extra.length > 0
          ? h('ul', { className: 'bln-list', key: 'x' }, extra.map((line, index) => h('li', { key: index }, line)))
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
        readStatus(ctx).then((result) => {
          if (alive) setState({ ...result, status: 'ready' })
        }, (error) => {
          if (alive) setState({ status: 'ready', kind: 'unavailable', reason: `reading status failed: ${error?.message ?? String(error)}` })
        })
        return () => { alive = false }
      }, [])

      if (state.status === 'loading') {
        return h('div', { className: 'bln-page' }, h('p', { className: 'bln-muted' }, '读取状态中…'))
      }
      const live = state.kind === 'ok' ? state.live : null
      return h('div', { className: 'bln-page' }, [
        h('div', { key: 'head' }, [
          h('h2', { className: 'bln-h', style: { fontSize: 16 } }, '百炼用量与价格'),
          h('p', { className: 'bln-muted', style: { margin: '4px 0 0' } },
            '只读视图。连接与模型清单在「设置 → 模型」里编辑；密钥只存于凭据 seam，配置里只有引用名。'),
        ]),
        h(ConnectionCard, { key: 'conn', live }),
        h(CacheCard, { key: 'cache' }),
        h(BillingCard, { key: 'billing', live }),
        state.kind === 'ok'
          ? (Array.isArray(state.failures) && state.failures.length > 0
              ? h(Unavailable, { key: 'partial', reason: '部分探测失败', extra: state.failures })
              : null)
          : h(Unavailable, { key: 'u', reason: state.reason, detail: state.detail }),
      ])
    }

    return {
      // Every lazily injected service must be declared by name: touching an
      // undeclared one throws `cannot get property "remote.<name>" without
      // inject`. This page reads the provider directory, the route registry and
      // one credential, so all four are listed.
      inject: ['slots', 'remote', 'remote.llm', 'remote.credentials'],
      apply(ctx) {
        // `styles` is a module-loader builtin of this bundle: a plain global in
        // the bundle's own scope, NOT a factory argument. Inserting through it is
        // cleaned up with the client run, so no effect wrapper is needed (and an
        // effect would only add a way for this to silently not run).
        try {
          if (typeof styles !== 'undefined' && styles !== null && typeof styles.insert === 'function') {
            styles.insert(css)
          } else if (typeof document !== 'undefined' && document.head !== null) {
            // Last-resort path if the builtin is absent in some deployment.
            const tag = document.createElement('style')
            tag.setAttribute('data-dsh-plugin', '@local/dsh-llm-bailian-native')
            tag.textContent = css
            document.head.appendChild(tag)
          }
        } catch (error) {
          // Styling must never be able to take the page down.
          console.error('[llm-bailian-native] could not insert the stylesheet', error)
        }
        clientCtx = ctx
        // The settings shell reads `label` for the nav row and `id` as the
        // section key it renders inside the panel content column.
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
