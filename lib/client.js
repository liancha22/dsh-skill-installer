/**
 * dsh-skill-installer · 浏览器半。
 *
 * 一个页面：`settings.plugins.tab` → 「技能安装器」。技能是 profile 级资产，
 * 跟具体会话无关，所以放设置区里当一个独立页面，而不是挂在会话上的浮层。
 *
 * 页面四件事：
 *   1) 列已装技能（名称 / 描述 / 来源根 / 可写性 / 被遮蔽）；
 *   2) 装技能：选来源（本地 / npm / GitHub）+ 填地址 + 选目标根（用户级 / 工作区级）；
 *   3) 卸技能：只对可写根开放，默认留备份；
 *   4) 显示两个目标根的真实路径，工作区路径可手填（设置页没有会话上下文）。
 *
 * 数据来自宿主半的 RPC 路由（同源相对路径）。手写 module-loader 包：
 * `window.__ModuleLoader__.load({ id, factory })`，factory 内 require('react')。
 *
 * **必须是单文件**：module-loader 的 require 只认平台种子词与已注册包，
 * 不支持相对路径（只有 require.async，且要求构建产物命名）。
 * 为了让「最长函数」可控，factory 只做接线；页面按职责摊成若干顶层小函数，
 * React 由参数传进来（顶层函数拿不到 factory 内的 require）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-skill-installer',
  factory: (require) => {
    var React = require('react')
    var logic = createLogic()
    return { name: 'dsh-skill-installer', apply: (ctx) => apply(ctx, React, logic) }
  },
})

/* --------------------------------- 常量与样式 --------------------------------- */

var RPC = '/skill-installer-rpc'

var SOURCES = [
  { key: 'local', label: '本地目录', hint: '/path/to/skills 或 /path/to/one-skill' },
  { key: 'npm', label: 'npm 包', hint: '包名，如 some-skills-deck' },
  { key: 'github', label: 'GitHub 仓库', hint: 'owner/repo 或 https://github.com/owner/repo' },
]

var TARGETS = [
  { key: 'user', label: '用户级（全局）' },
  { key: 'workspace', label: '工作区级（当前项目）' },
]

var CSS = [
  '.dshsi-root{padding:16px 18px;max-width:920px}',
  '.dshsi-h{font-size:15px;font-weight:600;margin:0 0 4px}',
  '.dshsi-sub{opacity:.7;font-size:12px;margin:0 0 14px;line-height:1.6}',
  '.dshsi-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0}',
  '.dshsi-in{flex:1 1 240px;min-width:160px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}',
  '.dshsi-btn{padding:6px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}',
  '.dshsi-btn[disabled]{opacity:.5;cursor:default}',
  '.dshsi-btn-primary{font-weight:600}',
  '.dshsi-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--dsw-alias-bg-overlay)}',
  '.dshsi-name{font-weight:600;font-size:13px}',
  '.dshsi-desc{font-size:12px;opacity:.8;margin-top:4px;line-height:1.5}',
  '.dshsi-meta{font-size:11px;opacity:.6;margin-top:6px;word-break:break-all}',
  '.dshsi-tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);margin-right:6px}',
  '.dshsi-err{color:#e5484d;font-size:12px;margin-top:8px;white-space:pre-wrap}',
  '.dshsi-ok{color:#30a46c;font-size:12px;margin-top:8px;white-space:pre-wrap}',
  '.dshsi-sec{margin-top:18px}',
  '.dshsi-sec>h4{font-size:13px;margin:0 0 8px;opacity:.85}',
  '.dshsi-empty{opacity:.6;font-size:12px}',
].join('\n')

/* --------------------------------- 纯逻辑 --------------------------------- */

/** RPC 客户端与状态机；与 React 无关，便于单独理解。 */
function createLogic() {
  function post(body) {
    return fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'HTTP ' + res.status } })
    })
  }

  /** 把一次操作的结果整理成给用户看的一句话。 */
  function describe(result, okText) {
    if (!result.ok) {
      var err = result.error || '操作失败'
      if (result.detail && result.detail.length > 0) err += '\n' + result.detail.join('\n')
      if (result.available && result.available.length > 0) err += '\n可选技能：' + result.available.join('、')
      return { kind: 'err', text: err }
    }
    var names = (result.installed || []).map(function (item) { return item.name })
    var text = names.length > 0 ? okText + '：' + names.join('、') : okText
    if (result.skipped && result.skipped.length > 0) {
      text += '\n跳过：' + result.skipped.map(function (item) {
        return item.name + '（' + item.reason + '）'
      }).join('；')
    }
    if (result.next) text += '\n' + result.next
    return { kind: 'ok', text: text }
  }

  return { post: post, describe: describe }
}

/* --------------------------------- 页面区块 --------------------------------- */

function InstallForm(props) {
  var h = props.h
  var [source, setSource] = props.React.useState('local')
  var [ref, setRef] = props.React.useState('')
  var [target, setTarget] = props.React.useState('user')
  var [overwrite, setOverwrite] = props.React.useState(false)
  var current = SOURCES.filter(function (item) { return item.key === source })[0] || SOURCES[0]

  return h('div', { className: 'dshsi-sec' },
    h('h4', null, '装技能'),
    h('div', { className: 'dshsi-row' },
      h('select', { className: 'dshsi-in', value: source, onChange: function (e) { setSource(e.target.value) } },
        SOURCES.map(function (item) { return h('option', { key: item.key, value: item.key }, item.label) })),
      h('select', { className: 'dshsi-in', value: target, onChange: function (e) { setTarget(e.target.value) } },
        TARGETS.map(function (item) { return h('option', { key: item.key, value: item.key }, item.label) })),
    ),
    h('div', { className: 'dshsi-row' },
      h('input', {
        className: 'dshsi-in',
        placeholder: current.hint,
        value: ref,
        onChange: function (e) { setRef(e.target.value) },
      }),
      h('label', { style: { fontSize: '12px', opacity: .8, display: 'flex', alignItems: 'center', gap: '4px' } },
        h('input', { type: 'checkbox', checked: overwrite, onChange: function (e) { setOverwrite(e.target.checked) } }),
        '同名覆盖（自动备份）'),
      h('button', {
        className: 'dshsi-btn dshsi-btn-primary',
        disabled: props.busy || ref.trim() === '',
        onClick: function () {
          props.onInstall({ method: 'install', source: source, ref: ref.trim(), target: target, overwrite: overwrite })
        },
      }, props.busy ? '处理中…' : '安装'),
    ),
  )
}

function SkillCard(props) {
  var h = props.h
  var skill = props.skill
  return h('div', { className: 'dshsi-card' },
    h('div', { className: 'dshsi-row', style: { margin: 0 } },
      h('span', { className: 'dshsi-name' }, skill.name),
      h('span', { className: 'dshsi-tag' }, skill.rootLabel),
      skill.shadowedBy ? h('span', { className: 'dshsi-tag' }, '被更高优先级遮蔽') : null,
    ),
    h('div', { className: 'dshsi-desc' }, skill.description),
    h('div', { className: 'dshsi-meta' }, (skill.path || '') + (skill.files ? ' · ' + skill.files + ' 个文件' : '')),
    skill.writable ? h('div', { className: 'dshsi-row' },
      h('button', {
        className: 'dshsi-btn',
        disabled: props.busy,
        onClick: function () { props.onUninstall(skill) },
      }, '卸载'),
    ) : null,
  )
}

function RootsList(props) {
  var h = props.h
  return h('div', { className: 'dshsi-sec' },
    h('h4', null, '技能根'),
    props.roots.map(function (root) {
      return h('div', { className: 'dshsi-card', key: root.kind },
        h('div', { className: 'dshsi-row', style: { margin: 0 } },
          h('span', { className: 'dshsi-name' }, root.label),
          h('span', { className: 'dshsi-tag' }, root.writable ? '可写' : '只读'),
        ),
        h('div', { className: 'dshsi-meta' }, root.dir),
      )
    }),
  )
}

/* --------------------------------- 页面 --------------------------------- */

/** 装/列/卸的状态与动作；把 IO 收在一处，页面组件只管画。 */
function useInstaller(React, logic) {
  var [state, setState] = React.useState({ loading: true, error: null, skills: [], roots: [], cwd: '' })
  var [busy, setBusy] = React.useState(false)
  var [note, setNote] = React.useState(null)
  var [workspace, setWorkspace] = React.useState('')

  var refresh = React.useCallback(function () {
    setState(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
    logic.post({ method: 'list', projectRoot: workspace || undefined }).then(function (result) {
      setState(function (prev) {
        return Object.assign({}, prev, {
          loading: false,
          error: result.ok ? null : (result.error || '读取失败'),
          skills: result.skills || [],
          roots: result.roots || [],
          cwd: result.cwd || prev.cwd,
        })
      })
    }).catch(function (error) {
      setState(function (prev) {
        return Object.assign({}, prev, { loading: false, error: String((error && error.message) || error) })
      })
    })
  }, [workspace])

  React.useEffect(function () { refresh() }, [refresh])

  var run = React.useCallback(function (body, okText) {
    setBusy(true)
    setNote(null)
    logic.post(Object.assign({ projectRoot: workspace || undefined }, body)).then(function (result) {
      setBusy(false)
      setNote(logic.describe(result, okText))
      if (result.ok) refresh()
    }).catch(function (error) {
      setBusy(false)
      setNote({ kind: 'err', text: String((error && error.message) || error) })
    })
  }, [workspace, refresh, logic])

  return {
    state: state,
    busy: busy,
    note: note,
    workspace: workspace,
    setWorkspace: setWorkspace,
    refresh: refresh,
    run: run,
  }
}

function Page(props) {
  var React = props.React
  var h = React.createElement
  var model = useInstaller(React, props.logic)
  var state = model.state

  return h('div', { className: 'dshsi-root' },
    h('h3', { className: 'dshsi-h' }, '技能安装器'),
    h('p', { className: 'dshsi-sub' },
      '把技能装进 DSH 的技能根：用户级装到 ~/.dsh/skills（所有会话可见），工作区级装到 <工作区>/.dsh/skills（只对该项目生效）。技能必须是 <技能名>/SKILL.md 且 frontmatter 带 name 与 description。'),

    h('div', { className: 'dshsi-row' },
      h('input', {
        className: 'dshsi-in',
        placeholder: '工作区路径（留空 = 宿主进程目录' + (state.cwd ? '：' + state.cwd : '') + '）',
        value: model.workspace,
        onChange: function (event) { model.setWorkspace(event.target.value) },
      }),
      h('button', { className: 'dshsi-btn', disabled: model.busy, onClick: model.refresh }, '刷新'),
    ),

    model.note !== null ? h('div', { className: model.note.kind === 'ok' ? 'dshsi-ok' : 'dshsi-err' }, model.note.text) : null,
    state.error !== null ? h('div', { className: 'dshsi-err' }, state.error) : null,

    h(InstallForm, {
      h: h,
      React: React,
      busy: model.busy,
      onInstall: function (body) { model.run(body, '已安装') },
    }),

    h('div', { className: 'dshsi-sec' },
      h('h4', null, '已装技能（' + state.skills.length + '）'),
      state.loading ? h('div', { className: 'dshsi-empty' }, '读取中…') : null,
      !state.loading && state.skills.length === 0 ? h('div', { className: 'dshsi-empty' }, '没有发现技能。') : null,
      state.skills.map(function (skill) {
        return h(SkillCard, {
          h: h,
          key: skill.rootKind + ':' + skill.name,
          skill: skill,
          busy: model.busy,
          onUninstall: function (item) {
            model.run({
              method: 'uninstall',
              name: item.name,
              target: item.rootKind === 'workspace' ? 'workspace' : 'user',
            }, '已卸载')
          },
        })
      }),
    ),

    h(RootsList, { h: h, roots: state.roots }),
  )
}

/* --------------------------------- 接线 --------------------------------- */

function apply(ctx, React, logic) {
  var slots = ctx.get('slots')
  if (slots === undefined) return

  ctx.effect(function () {
    var style = document.createElement('style')
    style.setAttribute('data-dsh-skill-installer', '')
    style.textContent = CSS
    document.head.appendChild(style)
    return function () {
      if (style.parentNode !== null) style.parentNode.removeChild(style)
    }
  }, 'dsh-skill-installer: styles')

  slots.inject('settings.plugins.tab', function () {
    return slots.register(
      { name: 'settings.plugins.tab', id: 'skill-installer', order: 60, label: '技能安装器' },
      function MountedPage() { return React.createElement(Page, { React: React, logic: logic }) },
    )
  })
}
