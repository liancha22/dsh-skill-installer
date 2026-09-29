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
import { resolve } from 'node:path'
import { PLUGIN_NAME, RPC_PATH, SOURCE_KINDS, SOURCE_LABELS, TARGET_KINDS, TARGET_LABELS, TOOL_NAME } from './core/constants.js'
import { createRunner } from './core/exec.js'
import { installSkills, uninstallSkill } from './core/install.js'
import { listSkills, targetRoot } from './core/roots.js'
import { truncate } from './core/util.js'

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

async function doList(runner, projectRoot) {
  const listed = listSkills(projectRoot)
  return {
    ok: true,
    op: 'list',
    count: listed.skills.length,
    cwd: projectRoot,
    skills: listed.skills.map((skill) => ({
      name: skill.name,
      description: truncate(skill.description, 120),
      rootKind: skill.rootKind,
      rootLabel: skill.rootLabel,
      path: skill.dir ?? skill.file,
      files: skill.files,
      writable: skill.writable,
      shadowedBy: skill.shadowedBy,
    })),
    roots: listed.roots.map((root) => ({ dir: root.dir, kind: root.kind, label: root.label, writable: root.writable })),
    hint: '装技能：op=install 带 source 与 ref；卸技能：op=uninstall 带 name 与 target。',
  }
}

function doRoots(projectRoot) {
  const listed = listSkills(projectRoot)
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

function doUninstall(args, projectRoot) {
  if (typeof args.name !== 'string' || args.name.trim() === '') return { ok: false, error: '卸载必须给 name' }
  const target = typeof args.target === 'string' && TARGET_KINDS.includes(args.target) ? args.target : 'user'
  const result = uninstallSkill({ name: args.name.trim(), target, projectRoot, keepBackup: args.overwrite !== true })
  return { op: 'uninstall', ...result }
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
        description: 'list 列技能与技能根 / install 装技能 / uninstall 卸技能 / roots 只看技能根',
        enum: ['list', 'install', 'uninstall', 'roots'],
      },
      source: { type: 'string', description: `install：来源类型（${SOURCE_KINDS.join(' / ')}）`, enum: SOURCE_KINDS },
      ref: { type: 'string', description: 'install：来源地址——本地绝对路径 / npm 包名 / GitHub owner/repo[#ref]' },
      target: { type: 'string', description: `安装目标根（默认 user）：${TARGET_KINDS.map((key) => `${key}=${TARGET_LABELS[key]}`).join('；')}`, enum: TARGET_KINDS },
      name: { type: 'string', description: 'install：只装技能包里这一个技能；uninstall：要卸的技能名' },
      overwrite: { type: 'boolean', description: 'install：同名技能已存在时覆盖（覆盖前自动备份）；uninstall：true 表示不留备份' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.session?.id
      const projectRoot = sessionCwd(ctx, sessionId)
      const runner = createRunner(ctx.get('subprocess'), ctx.get('timer'), projectRoot)
      if (args.op === 'roots') return doRoots(projectRoot)
      if (args.op === 'list') return doList(runner, projectRoot)
      if (args.op === 'install') return doInstall(runner, args, projectRoot)
      return doUninstall(args, projectRoot)
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

        // 面板在设置区里没有会话上下文，所以工作区路径由面板显式给；
        // 不给才退回「会话 cwd → 进程 cwd」。
        const projectRoot = typeof body.projectRoot === 'string' && body.projectRoot.trim() !== ''
          ? resolve(body.projectRoot.trim())
          : sessionCwd(ctx, typeof body.sessionId === 'string' ? body.sessionId : '')
        const runner = createRunner(ctx.get('subprocess'), ctx.get('timer'), projectRoot)
        try {
          const result = await dispatch(body, runner, projectRoot)
          respond(res, 200, result)
        } catch (error) {
          respond(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  })
}

async function dispatch(body, runner, projectRoot) {
  if (body.method === 'list') return doList(runner, projectRoot)
  if (body.method === 'roots') return doRoots(projectRoot)
  if (body.method === 'install') return doInstall(runner, body, projectRoot)
  if (body.method === 'uninstall') return doUninstall(body, projectRoot)
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

const MAX_BODY = 256 * 1024

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
