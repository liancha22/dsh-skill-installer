/**
 * dsh-skill-installer · 宿主半。
 *
 * 三件事：
 *   1) 注册模型工具 `skill_install`（列技能 / 装技能 / 卸技能）；
 *   2) 注册 systemPrompt 段，告诉模型「装技能要找这个工具，别去手改文件」；
 *   3) 注册 webServer 路由 `${RPC_PATH}`，给浏览器面板当唯一数据通道。
 *
 * 浏览器半在 ./client.js，由 package.json 的 dsh.client 声明被发现。
 * 安装动作**不在工具层直接写盘**：一律经 ./install.js，路径守卫在那里。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { PLUGIN_NAME, RPC_PATH, SOURCE_KINDS, SOURCE_LABELS, TARGET_KINDS, TARGET_LABELS, TOOL_NAME } from './core/constants.js'
import { createRunner } from './core/exec.js'
import { importPath } from './core/import.js'
import { installSkills, uninstallSkillAt } from './core/install.js'
import { existingSkill, listSkills, normalizeWorkspaces, targetRoot } from './core/roots.js'
import { repairFrontMatter, setDisabled } from './core/toggle.js'
import { ensureDir, safeJoin, truncate } from './core/util.js'

export const name = PLUGIN_NAME
export const inject = ['tools', 'systemPrompt', 'webServer']

const SECTION_NAME = 'skill-installer'
const ORDER = 620

const TOOL_DESCRIPTION = [
  '技能安装器：列出已装技能、从本地目录 / npm 包 / GitHub 仓库把技能装进 DSH 的技能根，或卸载技能。',
  `op=list 列技能与技能根；op=install 装（source=${SOURCE_KINDS.join(' / ')}，target=${TARGET_KINDS.join(' / ')}）；op=uninstall 卸；op=roots 只看技能根。`,
  `目标根：${TARGET_KINDS.map((key) => `${key}=${TARGET_LABELS[key]}`).join('；')}。用户级装到 ~/.dsh/skills（所有会话可见），工作区级装到 <项目>/.dsh/skills（只对该项目生效）。`,
  '技能必须是 <技能名>/SKILL.md 且 frontmatter 带 name 与 description；技能名用 kebab-case。',
  '装完要让技能被发现：宿主半改动需重启该 profile，纯技能文件改动会被文件监听自动拾取。',
].join('\n')

function policyText() {
  return [
    '# 技能安装（dsh-skill-installer）',
    `装/卸技能用工具 \`${TOOL_NAME}\`，不要手写 ~/.dsh/skills 下的文件。`,
    `op=install 支持 ${SOURCE_KINDS.map((key) => `${key}（${SOURCE_LABELS[key]}）`).join('、')}；target 分 user（全局）与 workspace（当前项目）。`,
    '技能名必须是 kebab-case，且 SKILL.md 的 frontmatter 必须有 name 与 description，否则装不进去。',
    '装完若技能没出现在可用列表里：宿主半改动需要重启 profile；只新增技能文件时文件监听会自动拾取。',
  ].join('\n')
}

/* --------------------------------- 会话与项目根 --------------------------------- */

function sessionCwd(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (sessions !== undefined && typeof sessionId === 'string' && sessionId !== '') {
    try {
      const live = sessions.get(sessionId)
      const cwd = live !== undefined && live !== null && live.header !== undefined ? live.header.cwd : undefined
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (_error) {
      /* 会话已不在内存里：退回进程工作目录 */
    }
  }
  try {
    return process.cwd()
  } catch (_error) {
    return '/'
  }
}

/* --------------------------------- 业务 --------------------------------- */

async function doList(runner, workspaces) {
  const listed = listSkills(workspaces)
  return {
    ok: true,
    op: 'list',
    count: listed.skills.length,
    workspaces: normalizeWorkspaces(workspaces).map((ws) => ({ path: ws.path, title: ws.title, workspaceId: ws.workspaceId })),
    skills: listed.skills.map((skill) => ({
      name: skill.name,
      description: truncate(skill.description, 120),
      rootKind: skill.rootKind,
      rootLabel: skill.rootLabel,
      // 工作区级技能要能看出「属于哪个工作区」，所以路径与工作区根都带上。
      rootDir: skill.rootDir,
      projectRoot: skill.rootProjectRoot,
      workspaceId: skill.rootWorkspaceId,
      path: skill.dir ?? skill.file,
      file: skill.file,
      files: skill.files,
      writable: skill.writable,
      shadowedBy: skill.shadowedBy,
      disabled: skill.disabled === true,
      modelHiddenOnly: skill.modelHiddenOnly === true,
      // 结束符坏了：DSH 会直接忽略这个技能。面板要标出来，否则用户以为「已启用」却不生效。
      brokenFrontMatter: skill.brokenFrontMatter === true,
      // 停用要能改回原样，所以把 SKILL.md 的真实路径一并给面板（目录型才有）。
      canToggle: skill.writable === true && typeof skill.file === 'string',
    })),
    roots: listed.roots.map((root) => ({
      dir: root.dir,
      kind: root.kind,
      label: root.label,
      writable: root.writable,
      projectRoot: root.projectRoot,
      workspaceId: root.workspaceId,
    })),
    hint: '装技能：op=install 带 source 与 ref；卸技能：op=uninstall 带 name 与 target。',
  }
}

function doRoots(workspaces) {
  const listed = listSkills(workspaces)
  return { ok: true, op: 'roots', roots: listed.roots }
}

async function doInstall(runner, args, projectRoot) {
  if (typeof args.source !== 'string' || !SOURCE_KINDS.includes(args.source)) {
    return { ok: false, error: `source 必须是 ${SOURCE_KINDS.join(' / ')}` }
  }
  if (typeof args.ref !== 'string' || args.ref.trim() === '') {
    return { ok: false, error: 'ref 不能为空（本地路径 / npm 包名 / GitHub owner/repo）' }
  }
  const target = typeof args.target === 'string' && TARGET_KINDS.includes(args.target) ? args.target : 'user'
  const result = await installSkills({
    source: args.source,
    ref: args.ref.trim(),
    target,
    projectRoot,
    overwrite: args.overwrite === true,
    only: typeof args.name === 'string' ? args.name : undefined,
    run: runner,
  })
  if (result.ok) {
    result.next = '技能文件已落盘。若可用技能列表没变，重启该 profile 后再看。'
  }
  return { op: 'install', ...result }
}

function doUninstall(args, workspaces) {
  if (typeof args.name !== 'string' || args.name.trim() === '') return { ok: false, error: '卸载必须给 name' }
  const located = locateSkill(args.name.trim(), args.target, workspaces, args.path)
  if (!located.ok) return located
  if (located.skill.writable !== true) {
    return { ok: false, error: `技能 ${args.name} 在只读根（${located.skill.rootLabel}），不能删` }
  }
  // 卸载的目标根取技能自己所在的那个根，而不是重新解析一遍——
  // 多个工作区下同名技能并存，重解析会指向别的根。
  const dir = located.skill.rootDir
  const found = existingSkill(dir, located.skill.name)
  if (found === null) return { ok: false, error: `目标根里没有技能 ${located.skill.name}` }
  const result = uninstallSkillAt(dir, located.skill.name, args.overwrite !== true)
  return { op: 'uninstall', targetKind: located.skill.rootKind, target: dir, ...result }
}

/** 启用 / 停用一个技能（改 SKILL.md 的 frontmatter，不动文件）。 */
function doToggle(args, workspaces) {
  if (typeof args.name !== 'string' || args.name.trim() === '') return { ok: false, error: '启用/停用必须给 name' }
  const located = locateSkill(args.name.trim(), args.target, workspaces, args.path)
  if (!located.ok) return located
  if (located.skill.writable !== true) {
    return { ok: false, error: `技能 ${args.name} 在只读根（${located.skill.rootLabel}），不能改` }
  }
  const disabled = args.disabled !== false
  const result = setDisabled(located.skill.file, disabled)
  if (!result.ok) return { op: 'toggle', ...result }
  return {
    ok: true,
    op: 'toggle',
    name: located.skill.name,
    disabled,
    path: located.skill.file,
    targetKind: located.skill.rootKind,
    target: located.skill.rootDir,
    changed: result.changed,
    next: '技能文件改动会被文件监听自动拾取，不必重启。',
  }
}

/** 导入：从用户选的路径装技能（.md / 目录 / .zip / .tar[.gz]）。 */
/** 修复 frontmatter 结束符（本插件早期版本可能写坏成 `----`）。 */
function doRepair(args, workspaces) {
  if (typeof args.name !== 'string' || args.name.trim() === '') return { ok: false, error: '修复必须给 name' }
  const located = locateSkill(args.name.trim(), args.target, workspaces, args.path)
  if (!located.ok) return located
  if (located.skill.writable !== true) {
    return { ok: false, error: `技能 ${args.name} 在只读根（${located.skill.rootLabel}），不能改` }
  }
  const result = repairFrontMatter(located.skill.file)
  if (!result.ok) return { op: 'repair', ...result }
  return {
    ok: true,
    op: 'repair',
    name: located.skill.name,
    path: located.skill.file,
    changed: result.changed,
    next: result.changed
      ? '结束符已修回 `---`，DSH 现在能读到这个技能了；新会话即可使用。'
      : '这个技能的结束符本来就是好的，没动它。',
  }
}

async function doImport(runner, args, projectRoot) {
  if (typeof args.path !== 'string' || args.path.trim() === '') return { ok: false, error: '导入必须给 path' }
  const target = typeof args.target === 'string' && TARGET_KINDS.includes(args.target) ? args.target : 'user'
  const result = await importPath({
    path: args.path.trim(),
    target,
    projectRoot,
    overwrite: args.overwrite === true,
    run: runner,
  })
  return { op: 'import', ...result }
}

/**
 * 导入浏览器上传的文件。
 *
 * 浏览器出于安全只给文件名、不给真实路径，所以面板读字节传上来，
 * 这里落到临时文件再走同一套导入逻辑——路径导入与上传导入只有「文件从哪来」不同。
 */
async function doImportUpload(runner, args, projectRoot) {
  const name = typeof args.fileName === 'string' ? args.fileName.trim() : ''
  if (name === '') return { ok: false, error: '缺少 fileName' }
  if (typeof args.dataBase64 !== 'string' || args.dataBase64 === '') return { ok: false, error: '缺少文件内容' }
  const safeName = name.replace(/[\\/]/g, '_').replace(/^\.+/, '')
  if (safeName === '') return { ok: false, error: '文件名不合法' }

  // 上传的字节落到系统临时区，别在工作区里建目录（工作区可能不可写）。
  const tempBase = safeJoin(tmpdir(), 'dsh-skill-installer')
  if (tempBase === null) return { ok: false, error: '临时目录非法' }
  ensureDir(tempBase)
  const temp = safeJoin(tempBase, `upload-${Date.now()}-${safeName}`)
  if (temp === null) return { ok: false, error: '临时路径非法' }
  try {
    writeFileSync(temp, Buffer.from(args.dataBase64, 'base64'))
    const target = typeof args.target === 'string' && TARGET_KINDS.includes(args.target) ? args.target : 'user'
    const result = await importPath({ path: temp, target, projectRoot, overwrite: args.overwrite === true, run: runner })
    return { op: 'import', uploaded: name, ...result }
  } finally {
    try { rmSync(temp, { force: true }) } catch (_error) { /* 临时文件清不掉不影响结果 */ }
  }
}

/**
 * 在可写根里定位一个技能。
 *
 * 同名技能可能同时存在于用户级与多个工作区级，所以定位要看两件事：
 *   - `target`：user / workspace 二选一（对应面板上那个唯一的目标下拉）；
 *   - `path`：技能所在目录的绝对路径（面板点哪张卡片就给哪个路径）。
 *
 * 给了 path 就以它为准——多个工作区下同名技能并存时，只有路径能区分是哪一个，
 * 光靠 name + target 会挑到第一个，删错工作区的技能。
 */
function locateSkill(name, target, workspaces, path) {
  const kind = typeof target === 'string' && TARGET_KINDS.includes(target) ? target : undefined
  const listed = listSkills(workspaces)
  const candidates = listed.skills.filter((skill) => skill.name === name)
  if (candidates.length === 0) return { ok: false, error: `没有找到技能 ${name}` }

  if (typeof path === 'string' && path.trim() !== '') {
    const want = resolve(path.trim())
    const hit = candidates.find((skill) => skill.rootDir === want || (skill.dir ?? skill.file) === want)
    if (hit !== undefined) return { ok: true, skill: hit }
  }

  // workspace 目标是「根类型」，不是具体某个工作区：所有工作区级根都算数。
  const inKind = kind === 'workspace'
    ? candidates.filter((skill) => skill.rootKind === 'workspace' || skill.rootKind === 'workspace-agents')
    : kind === undefined ? candidates : candidates.filter((skill) => skill.rootKind === kind)
  const hit = inKind[0]
  if (hit === undefined) {
    return {
      ok: false,
      error: `技能 ${name} 不在 ${TARGET_LABELS[kind]} 根里`,
      available: candidates.map((skill) => `${skill.rootKind}：${skill.rootDir}`),
    }
  }
  if (inKind.length > 1) {
    return {
      ok: false,
      error: `技能 ${name} 在多个根里都存在（${inKind.length} 个），必须给 path 指定是哪一个`,
      available: inKind.map((skill) => skill.rootDir),
    }
  }
  return { ok: true, skill: hit }
}

/* --------------------------------- 注册 --------------------------------- */

export function apply(ctx) {
  ctx.systemPrompt.section({ name: SECTION_NAME, order: ORDER, text: policyText() })

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      op: {
        type: 'string',
        required: true,
        description: 'list 列技能与技能根 / install 装技能 / import 从文件导入 / toggle 启用或停用 / repair 修复损坏的 frontmatter / uninstall 卸技能 / roots 只看技能根',
        enum: ['list', 'install', 'import', 'toggle', 'repair', 'uninstall', 'roots'],
      },
      source: { type: 'string', description: `install：来源类型（${SOURCE_KINDS.join(' / ')}）`, enum: SOURCE_KINDS },
      ref: { type: 'string', description: 'install：来源地址——本地绝对路径 / npm 包名 / GitHub owner/repo[#ref]' },
      path: { type: 'string', description: 'import：要导入的路径——.md 单文件 / 技能目录 / .zip / .tar / .tar.gz；toggle/uninstall：技能所在根目录（多个工作区下有同名技能时必须给）' },
      target: { type: 'string', description: `安装目标根（默认 user）：${TARGET_KINDS.map((key) => `${key}=${TARGET_LABELS[key]}`).join('；')}`, enum: TARGET_KINDS },
      name: { type: 'string', description: 'install：只装技能包里这一个技能；toggle/uninstall：技能名' },
      disabled: { type: 'boolean', description: 'toggle：true 停用（模型与用户都不可调用），false 启用；默认 true' },
      overwrite: { type: 'boolean', description: 'install/import：同名已存在时覆盖（覆盖前自动备份）；uninstall：true 表示不留备份' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      // 工具调用只有会话上下文，没有 DSH 的工作区列表，所以把会话 cwd 当成
      // 「唯一的工作区」传进去——面板那条路会拿到完整列表。
      const workspaces = normalizeWorkspaces(sessionCwd(ctx, sessionId))
      const projectRoot = workspaces[0]?.path
      const runner = createRunner(ctx.get('subprocess'), ctx.get('timer'), projectRoot)
      if (args.op === 'roots') return doRoots(workspaces)
      if (args.op === 'list') return doList(runner, workspaces)
      if (args.op === 'install') return doInstall(runner, args, projectRoot)
      if (args.op === 'import') return doImport(runner, args, projectRoot)
      if (args.op === 'toggle') return doToggle(args, workspaces)
      if (args.op === 'repair') return doRepair(args, workspaces)
      return doUninstall(args, workspaces)
    },
  }))

  /* ------------------------------ 浏览器通道 ------------------------------ */

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        const rejection = webCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          respond(res, rejection, { ok: false, error: '需要当前浏览器鉴权' })
          return
        }
        if (req.method !== 'POST') {
          respond(res, 405, { ok: false, error: 'POST required' })
          return
        }
        let body
        try {
          body = JSON.parse(await readBody(req))
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('bad body')
        } catch (_error) {
          respond(res, 400, { ok: false, error: '请求正文必须是 JSON 对象' })
          return
        }

        // 面板在设置区里没有会话上下文，所以：
        //   - `workspaces`：面板把 DSH 的整个工作区列表传上来，用来列技能、标出来源；
        //   - `projectRoot`：面板当前**选中的**那个工作区，装/卸工作区级技能时用它。
        // 面板什么都不给（旧调用方）才退回会话 cwd。
        const fallback = sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : '')
        const workspaces = normalizeWorkspaces(
          body.workspaces !== undefined && body.workspaces !== null ? body.workspaces : fallback,
        )
        const projectRoot = typeof body.projectRoot === 'string' && body.projectRoot.trim() !== ''
          ? resolve(body.projectRoot.trim())
          : workspaces[0]?.path ?? fallback
        const runner = createRunner(ctx.get('subprocess'), ctx.get('timer'), projectRoot)
        try {
          const result = await dispatch(body, runner, workspaces, projectRoot)
          respond(res, 200, result)
        } catch (error) {
          respond(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  })
}

async function dispatch(body, runner, workspaces, projectRoot) {
  if (body.method === 'list') return doList(runner, workspaces)
  if (body.method === 'roots') return doRoots(workspaces)
  if (body.method === 'install') return doInstall(runner, body, projectRoot)
  if (body.method === 'import') return doImport(runner, body, projectRoot)
  if (body.method === 'importUpload') return doImportUpload(runner, body, projectRoot)
  if (body.method === 'toggle') return doToggle(body, workspaces)
  if (body.method === 'repair') return doRepair(body, workspaces)
  if (body.method === 'uninstall') return doUninstall(body, workspaces)
  if (body.method === 'targets') {
    return {
      ok: true,
      targets: TARGET_KINDS.map((key) => {
        const resolved = targetRoot(key, projectRoot)
        return { kind: key, label: TARGET_LABELS[key], dir: resolved.ok ? resolved.dir : null, error: resolved.ok ? undefined : resolved.error }
      }),
    }
  }
  return { ok: false, error: `未知 method：${String(body.method)}` }
}

/* --------------------------------- HTTP 小工具 --------------------------------- */

// 技能包可能不小，上传是 base64 编码（膨胀 ~1.33 倍），所以给到 24MB。
const MAX_BODY = 24 * 1024 * 1024

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = ''
    let bytes = 0
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > MAX_BODY) {
        rejectPromise(new Error('请求过大'))
        req.destroy()
        return
      }
      data += chunk
    })
    req.on('end', () => resolvePromise(data))
    req.on('error', rejectPromise)
  })
}

function respond(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}
