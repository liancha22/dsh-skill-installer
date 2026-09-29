/**
 * dsh-skill-installer · 浏览器半。
 *
 * 一个页面：`settings.section` → 「技能安装器」。技能是 profile 级资产，
 * 跟具体会话无关，所以放设置区里当一个独立页面，而不是挂在会话上的浮层。
 *
 * 页面四件事：
 *   1) 列已装技能（名称 / 描述 / **属于哪个工作区** / 可写性 / 被遮蔽）；
 *   2) 装技能：选来源（本地 / npm / GitHub）+ 填地址；
 *   3) 卸技能：只对可写根开放，默认留备份；
 *   4) 显示技能根的真实路径。
 *
 * **只有一个「安装到」下拉**：不选 = 用户级，选了工作区 = 装到那个工作区。
 * 早先这里是两个互不相干的下拉（顶部「工作区」+ 装技能区「目标根」），
 * 结果是「顶部选了工作区、装技能区还停在用户级」，装到哪全看后一个下拉——
 * 用户看到的就是「我选了工作区，怎么装到用户级了」。语义重叠的下拉必须合成一个。
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
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement


    /* --------------------------------- 常量与样式 --------------------------------- */

    var RPC = '/skill-installer-rpc'

    var SOURCES = [
      { key: 'local', label: '本地目录', hint: '/path/to/skills 或 /path/to/one-skill' },
      { key: 'npm', label: 'npm 包', hint: '包名，如 some-skills-deck' },
      { key: 'github', label: 'GitHub 仓库', hint: 'owner/repo 或 https://github.com/owner/repo' },
    ]

    /** 「安装到」下拉的空值 = 用户级；其余值是工作区路径。 */
    var USER_VALUE = ''

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
      '.dshsi-tag-ws{border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2));font-weight:600}',
      '.dshsi-tag-off{opacity:.75}',
      '.dshsi-off{opacity:.62}',
      '.dshsi-btn-danger{color:#e5484d}',
      '.dshsi-err{color:#e5484d;font-size:12px;margin-top:8px;white-space:pre-wrap}',
      '.dshsi-ok{color:#30a46c;font-size:12px;margin-top:8px;white-space:pre-wrap}',
      '.dshsi-sec{margin-top:18px}',
      '.dshsi-sec>h4{font-size:13px;margin:0 0 8px;opacity:.85}',
      '.dshsi-empty{opacity:.6;font-size:12px}',
      '.dshsi-group{margin:12px 0 4px;font-size:12px;font-weight:600;opacity:.9}',
      '.dshsi-group .dshsi-meta{margin-top:2px;font-weight:400}',
      '.dshsi-dest{font-size:12px;margin:2px 0 0;opacity:.75;word-break:break-all}',
    ].join('\n')

    /** RPC 客户端与状态机（闭包级单例）。 */
    var logic = createLogic()

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
          if (result.available && result.available.length > 0) err += '\n可选：' + result.available.join('、')
          return { kind: 'err', text: err }
        }
        var names = (result.installed || []).map(function (item) { return item.name })
        var text = names.length > 0 ? okText + '：' + names.join('、') : okText
        // 装完一定要说清装到哪了——「装到哪个工作区」正是用户最容易看不清的地方。
        if (result.target) text += '\n位置：' + result.target
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

    /** 「安装到」的取值 → 宿主半要的 target / projectRoot。 */
    function destToArgs(dest) {
      return dest === USER_VALUE ? { target: 'user' } : { target: 'workspace', projectRoot: dest }
    }

    /* --------------------------------- 页面区块 --------------------------------- */

    /**
     * 装技能。
     *
     * 目标由页面顶部的「安装到」统一决定，这里**不再放第二个目标下拉**：
     * 两个语义重叠的下拉正是「选了工作区却装到用户级」的来源。
     */
    function InstallForm(props) {
      var h = props.h
      var [source, setSource] = React.useState('local')
      var [ref, setRef] = React.useState('')
      var [overwrite, setOverwrite] = React.useState(false)
      var current = SOURCES.filter(function (item) { return item.key === source })[0] || SOURCES[0]

      return h('div', { className: 'dshsi-sec' },
        h('h4', null, '装技能'),
        h('div', { className: 'dshsi-row' },
          h('select', { className: 'dshsi-in', value: source, onChange: function (e) { setSource(e.target.value) } },
            SOURCES.map(function (item) { return h('option', { key: item.key, value: item.key }, item.label) })),
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
              props.onInstall({ method: 'install', source: source, ref: ref.trim(), overwrite: overwrite })
            },
          }, props.busy ? '处理中…' : '安装'),
        ),
      )
    }

    function SkillCard(props) {
      var h = props.h
      var skill = props.skill
      var off = skill.disabled === true
      var isWorkspace = skill.rootKind === 'workspace' || skill.rootKind === 'workspace-agents'
      return h('div', { className: 'dshsi-card' + (off ? ' dshsi-off' : '') },
        h('div', { className: 'dshsi-row', style: { margin: 0 } },
          h('span', { className: 'dshsi-name' }, skill.name),
          h('span', { className: 'dshsi-tag' + (isWorkspace ? ' dshsi-tag-ws' : '') },
            isWorkspace ? '工作区：' + skill.rootLabel : skill.rootLabel),
          off ? h('span', { className: 'dshsi-tag dshsi-tag-off' }, '已停用') : null,
          skill.modelHiddenOnly ? h('span', { className: 'dshsi-tag dshsi-tag-off' }, '仅模型不可见') : null,
          skill.shadowedBy ? h('span', { className: 'dshsi-tag' }, '被 ' + skill.shadowedBy + ' 遮蔽') : null,
        ),
        h('div', { className: 'dshsi-desc' }, skill.description),
        h('div', { className: 'dshsi-meta' }, (skill.path || '') + (skill.files ? ' · ' + skill.files + ' 个文件' : '')),
        skill.writable ? h('div', { className: 'dshsi-row' },
          h('button', {
            className: 'dshsi-btn',
            disabled: props.busy,
            onClick: function () { props.onToggle(skill, !off) },
          }, off ? '启用' : '停用'),
          h('button', {
            className: 'dshsi-btn dshsi-btn-danger',
            disabled: props.busy,
            onClick: function () { props.onRemove(skill) },
          }, '删除'),
        ) : h('div', { className: 'dshsi-meta' }, '（只读根，不能改）'),
      )
    }

    function RootsList(props) {
      var h = props.h
      return h('div', { className: 'dshsi-sec' },
        h('h4', null, '技能根（' + props.roots.length + '）'),
        props.roots.map(function (root) {
          return h('div', { className: 'dshsi-card', key: root.dir },
            h('div', { className: 'dshsi-row', style: { margin: 0 } },
              h('span', { className: 'dshsi-name' },
                (root.kind === 'workspace' || root.kind === 'workspace-agents' ? '工作区：' + root.label : root.label)),
              h('span', { className: 'dshsi-tag' }, root.writable ? '可写' : '只读'),
            ),
            h('div', { className: 'dshsi-meta' }, root.dir),
          )
        }),
      )
    }

    /**
     * 「安装到」选择：**一个下拉决定一切**。
     * 不选 = 用户级（所有会话可见）；选了某个工作区 = 装到该工作区的 .dsh/skills。
     */
    function DestinationPicker(props) {
      var h = props.h
      var items = props.workspaces
      return h('select', {
        className: 'dshsi-in',
        value: props.dest,
        onChange: function (event) { props.onChange(event.target.value) },
      },
        h('option', { value: USER_VALUE }, '用户级（全局 · 所有会话可见）'),
        items.map(function (item) {
          return h('option', { key: item.path, value: item.path },
            '工作区：' + (item.title || item.path) + '  —  ' + item.path)
        }),
      )
    }

    /**
     * 导入区。
     *
     * 两条路：
     *   1) 选文件 —— 浏览器读字节转 base64 交给宿主（浏览器拿不到真实路径，只能这么传）；
     *   2) 填路径 —— 直接给宿主一个服务器上已存在的绝对路径（手机上就是 /sdcard/...）。
     *
     * 目标同样由页面顶部的「安装到」决定。
     */
    function ImportForm(props) {
      var h = props.h
      var [path, setPath] = React.useState('')
      var [reading, setReading] = React.useState(false)
      var fileRef = React.useRef(null)

      function pick(event) {
        var file = event.target.files && event.target.files[0]
        if (file === undefined || file === null) return
        setReading(true)
        var reader = new FileReader()
        reader.onload = function () {
          var text = String(reader.result || '')
          var comma = text.indexOf(',')
          props.onUpload(file.name, comma >= 0 ? text.slice(comma + 1) : text)
          setReading(false)
          if (fileRef.current !== null) fileRef.current.value = ''
        }
        reader.onerror = function () {
          setReading(false)
          props.onError('读文件失败：' + String(reader.error && reader.error.message || reader.error))
        }
        reader.readAsDataURL(file)
      }

      return h('div', { className: 'dshsi-sec' },
        h('h4', null, '导入'),
        h('div', { className: 'dshsi-row' },
          h('input', {
            ref: fileRef,
            type: 'file',
            // 不给 accept：Android 的 chooser 主要按 MIME 过滤，而 .md 没有注册的
            // MIME 类型（text/markdown 在多数国产 ROM 上不认），一写 accept 就会
            // 把 .md 整个挡掉。这里放开，由导入逻辑按扩展名判类型。
            disabled: props.busy || reading,
            style: { fontSize: '12px', flex: '1 1 220px' },
            onChange: pick,
          }),
          reading ? h('span', { className: 'dshsi-meta' }, '读取中…') : null,
        ),
        h('div', { className: 'dshsi-row' },
          h('input', {
            className: 'dshsi-in',
            placeholder: '或填服务器上的绝对路径：/sdcard/Download/xxx.zip 或技能目录',
            value: path,
            onChange: function (event) { setPath(event.target.value) },
          }),
          h('button', {
            className: 'dshsi-btn dshsi-btn-primary',
            disabled: props.busy || path.trim() === '',
            onClick: function () { props.onImportPath(path.trim()) },
          }, '按路径导入'),
        ),
        h('div', { className: 'dshsi-meta' }, '支持 .md 单文件、技能目录、.zip、.tar、.tar.gz。选文件会把内容直接传给宿主；填路径则要求该路径在手机上真实存在。'),
      )
    }

    /* --------------------------------- 页面 --------------------------------- */

    /**
     * 装/列/卸的状态与动作；把 IO 收在一处，页面组件只管画。
     *
     * 依赖陷阱：`props.workspaces` 每次渲染都是新数组，直接进 useCallback 依赖会
     * 「渲染 → effect 重跑 → setState → 再渲染」无限循环。所以只把**路径串**当依赖，
     * 数组本身放 ref 里取最新值。
     */
    function useInstaller(props) {
      var workspaces = props && props.workspaces ? props.workspaces : []
      var key = workspaces.map(function (item) { return item.path }).join('|')
      var latest = React.useRef(workspaces)
      latest.current = workspaces

      var [state, setState] = React.useState({ loading: true, error: null, skills: [], roots: [], targets: [] })
      var [busy, setBusy] = React.useState(false)
      var [note, setNote] = React.useState(null)
      // dest === '' 表示用户级；否则是工作区路径。一个值同时决定「装到哪」。
      var [dest, setDest] = React.useState(USER_VALUE)

      var refresh = React.useCallback(function () {
        setState(function (prev) { return Object.assign({}, prev, { loading: true, error: null }) })
        logic.post({ method: 'list', workspaces: latest.current, projectRoot: dest || undefined }).then(function (result) {
          setState(function (prev) {
            return Object.assign({}, prev, {
              loading: false,
              error: result.ok ? null : (result.error || '读取失败'),
              skills: result.skills || [],
              roots: result.roots || [],
            })
          })
        }).catch(function (error) {
          setState(function (prev) {
            return Object.assign({}, prev, { loading: false, error: String((error && error.message) || error) })
          })
        })
      }, [key, dest])

      React.useEffect(function () { refresh() }, [refresh])

      /** 目标根真实路径：让「装到哪」在点安装之前就看得见。 */
      var loadTargets = React.useCallback(function () {
        logic.post({ method: 'targets', workspaces: latest.current, projectRoot: dest || undefined }).then(function (result) {
          if (result.ok) setState(function (prev) { return Object.assign({}, prev, { targets: result.targets || [] }) })
        })
      }, [key, dest])

      React.useEffect(function () { loadTargets() }, [loadTargets])

      var run = React.useCallback(function (body, okText) {
        setBusy(true)
        setNote(null)
        // workspaces 给列表用，projectRoot 给落盘用——两者必须一起发。
        var payload = Object.assign({ workspaces: latest.current, projectRoot: dest || undefined }, body)
        logic.post(payload).then(function (result) {
          setBusy(false)
          setNote(logic.describe(result, okText))
          if (result.ok) refresh()
        }).catch(function (error) {
          setBusy(false)
          setNote({ kind: 'err', text: String((error && error.message) || error) })
        })
      }, [key, dest, refresh])

      /** 上传一个文件并导入（浏览器读到的字节，base64 传给宿主）。 */
      var upload = React.useCallback(function (fileName, dataBase64) {
        run(Object.assign({ method: 'importUpload', fileName: fileName, dataBase64: dataBase64 }, destToArgs(dest)), '已导入')
      }, [run, dest])

      var importPath = React.useCallback(function (path) {
        run(Object.assign({ method: 'import', path: path }, destToArgs(dest)), '已导入')
      }, [run, dest])

      return {
        state: state,
        busy: busy,
        note: note,
        dest: dest,
        setDest: setDest,
        refresh: refresh,
        run: run,
        upload: upload,
        importPath: importPath,
        setNote: setNote,
      }
    }

    /** 技能根类型 → 宿主半要的 target 取值。 */
    function targetOf(kind) {
      return kind === 'workspace' || kind === 'workspace-agents' ? 'workspace' : 'user'
    }

    /** 当前「安装到」解析出来的真实目录；解析不出来给 null。 */
    function resolvedDir(model) {
      var wanted = model.dest === USER_VALUE ? 'user' : 'workspace'
      var hit = (model.state.targets || []).filter(function (item) { return item.kind === wanted })[0]
      if (hit === undefined) return null
      return hit.dir || hit.error || null
    }

    /** 按技能根分组，让「哪个技能属于哪个工作区」一眼看出来。 */
    function groupByRoot(skills, roots) {
      var order = roots.map(function (root) { return root.dir })
      var groups = []
      var byDir = {}
      for (const skill of skills) {
        var dir = skill.rootDir || ''
        if (byDir[dir] === undefined) {
          byDir[dir] = { dir: dir, label: skill.rootLabel, kind: skill.rootKind, writable: skill.writable, skills: [] }
          groups.push(byDir[dir])
        }
        byDir[dir].skills.push(skill)
      }
      groups.sort(function (a, b) {
        var ia = order.indexOf(a.dir)
        var ib = order.indexOf(b.dir)
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib)
      })
      return groups
    }

    function Page(props) {
      var h = React.createElement
      var model = useInstaller(props)
      var state = model.state
      var destDir = resolvedDir(model)

      return h('div', { className: 'dshsi-root' },
        h('h3', { className: 'dshsi-h' }, '技能安装器'),
        h('p', { className: 'dshsi-sub' },
          '装/卸技能，并查看每个技能属于哪个工作区。用户级装到 ~/.dsh/skills（所有会话可见），工作区级装到 <工作区>/.dsh/skills（只对该项目生效）。'),

        h('div', { className: 'dshsi-sec' },
          h('h4', null, '安装到'),
          h('div', { className: 'dshsi-row' },
            h(DestinationPicker, {
              h: h,
              workspaces: props.workspaces || [],
              dest: model.dest,
              onChange: model.setDest,
            }),
            h('button', { className: 'dshsi-btn', disabled: model.busy, onClick: model.refresh }, '刷新'),
          ),
          destDir !== null ? h('p', { className: 'dshsi-dest' }, '实际目录：' + destDir) : null,
          (props.workspaces || []).length === 0
            ? h('p', { className: 'dshsi-dest' }, '没读到工作区列表，只能装用户级。')
            : null,
        ),

        model.note !== null ? h('div', { className: model.note.kind === 'ok' ? 'dshsi-ok' : 'dshsi-err' }, model.note.text) : null,
        state.error !== null ? h('div', { className: 'dshsi-err' }, state.error) : null,

        h(InstallForm, {
          h: h,
          busy: model.busy,
          onInstall: function (body) {
            model.run(Object.assign({}, body, destToArgs(model.dest)), '已安装')
          },
        }),

        h(ImportForm, {
          h: h,
          busy: model.busy,
          onUpload: model.upload,
          onImportPath: model.importPath,
          onError: function (text) { model.setNote({ kind: 'err', text: text }) },
        }),

        h('div', { className: 'dshsi-sec' },
          h('h4', null, '技能管理（' + state.skills.length + '）'),
          h('div', { className: 'dshsi-meta' }, '按技能根分组，标签写明属于哪个工作区。可写根里的技能可以启用 / 停用（改 SKILL.md 的 frontmatter，不动文件）或删除。'),
          state.loading ? h('div', { className: 'dshsi-empty' }, '读取中…') : null,
          !state.loading && state.skills.length === 0 ? h('div', { className: 'dshsi-empty' }, '没有发现技能。') : null,
          groupByRoot(state.skills, state.roots).map(function (group) {
            return h('div', { key: group.dir },
              h('div', { className: 'dshsi-group' },
                (group.kind === 'workspace' || group.kind === 'workspace-agents'
                  ? '工作区：' + group.label
                  : group.label) + '（' + group.skills.length + '）' + (group.writable ? '' : ' · 只读'),
                h('div', { className: 'dshsi-meta' }, group.dir),
              ),
              group.skills.map(function (skill) {
                return h(SkillCard, {
                  h: h,
                  key: group.dir + ':' + skill.name,
                  skill: skill,
                  busy: model.busy,
                  // 同名技能可能散在多个根里，所以带上技能所在根路径，宿主半按它精确定位。
                  onToggle: function (item, disabled) {
                    model.run({
                      method: 'toggle',
                      name: item.name,
                      target: targetOf(item.rootKind),
                      path: item.rootDir,
                      disabled: disabled,
                    }, disabled ? '已停用' : '已启用')
                  },
                  onRemove: function (item) {
                    model.run({
                      method: 'uninstall',
                      name: item.name,
                      target: targetOf(item.rootKind),
                      path: item.rootDir,
                    }, '已删除')
                  },
                })
              }),
            )
          }),
        ),

        h(RootsList, { h: h, roots: state.roots }),
      )
    }

    /* --------------------------------- 接线 --------------------------------- */

    function apply(ctx) {
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

      // 注册到 settings.section：设置左侧导航里的**独立一项**（与「思考强度」「提示缓存」同层）。
      // 别用 settings.plugins.tab —— 那是「插件」页内部的一个子标签，导航里看不到入口。
      //
      // useWorkspaces 是 settings.section 的标准 props 之一，直接拿 DSH 自己的工作区列表，
      // 比让用户手填路径可靠。
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'skill-installer', label: '技能安装器', order: 65 },
          PageWithWorkspaces,
        )
      })
    }

    /**
     * 把 useWorkspaces 的快照转成下拉与分组用的 { title, path, workspaceId } 列表。
     *
     * 用 useMemo 按快照引用缓存：这里每次返回新数组，直接喂给 useInstaller 会让
     * 它的依赖串每渲染都变，进而 effect 反复重跑。
     */
    function WorkspacesFromProps(ownerProps) {
      var hook = ownerProps === undefined || ownerProps === null ? undefined : ownerProps.useWorkspaces
      var snapshot
      if (typeof hook === 'function') {
        try {
          snapshot = hook(function (value) { return value })
        } catch (_error) {
          snapshot = undefined
        }
      }
      var items = snapshot === undefined || snapshot === null || !Array.isArray(snapshot.items) ? [] : snapshot.items
      return React.useMemo(function () {
        return items
          .filter(function (item) { return item !== null && typeof item.path === 'string' && item.path !== '' })
          .map(function (item) {
            return {
              title: item.title || '',
              path: item.path,
              workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : undefined,
            }
          })
      }, [snapshot])
    }

    /** 壳：把工作区列表算好后交给 Page（hooks 必须在组件里调用，不能塞进 Page 内部条件分支）。 */
    function PageWithWorkspaces(props) {
      var workspaces = WorkspacesFromProps(props)
      return React.createElement(Page, { workspaces: workspaces })
    }


    module.exports = { name: 'dsh-skill-installer', apply: apply }
    return module.exports
  },
})
