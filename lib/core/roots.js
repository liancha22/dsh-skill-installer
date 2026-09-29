/**
 * 技能根解析与清单。
 *
 * 目标根（本插件可写的）：
 *   - 用户级：`~/.dsh/skills`（与 dsh-skill-filesystem 的 user-dsh 根同一处）；
 *   - 工作区级：`<工作区根>/.dsh/skills`（与 project-dsh 根同一处）。
 *
 * 只读探测另外两个根（用户/工作区的 .agents/skills），因为技能可能装在那里，
 * 面板要如实显示「这个技能是从哪来的」。
 *
 * **可以同时有多个工作区**：面板把 DSH 的工作区列表整个传进来，每个工作区各扫一份，
 * 技能卡片上就能标出「这条属于哪个工作区」——只有一个工作区时看不出问题，
 * 多个工作区时「装到哪了」全靠这个标记。
 *
 * 根的顺序与 dsh-skill-filesystem 的 rank 一致：工作区级优先于用户级，
 * 同名技能先出现的胜出，后面的标记为「被遮蔽」。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { TARGET_KINDS } from './constants.js'
import { parseFrontMatter, readFlatSkill, readSkill } from './skillfile.js'
import { isDisabled, isModelHiddenOnly } from './toggle.js'
import { isDir, isFile, listEntries } from './util.js'

/** DSH home：优先环境变量，兜底 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(homedir(), '.dsh')
}

/** .agents 根：技能也可能装在这里（只读探测）。 */
export function agentsHome() {
  const fromEnv = process.env.DSH_AGENTS_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return resolve(homedir(), '.agents')
}

/** 用户级技能根。工作区级与它相同就意味着「装错地方」，多处要用到。 */
export function userSkillsDir() {
  return resolve(dshHome(), 'skills')
}

/**
 * 把各种形状的工作区入参统一成 `{ path, title, workspaceId }[]`。
 *
 * 兼容三种调用方：面板传对象数组（带标题）、工具传单个路径字符串、
 * 旧调用方传 undefined。顺带按绝对路径去重，免得同一个工作区扫两遍。
 *
 * @param {undefined|string|object|Array<string|object>} input
 * @returns {{ path: string, title: string, workspaceId: string|undefined }[]}
 */
export function normalizeWorkspaces(input) {
  if (input === undefined || input === null) return []
  const raw = Array.isArray(input) ? input : [input]
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const value = typeof item === 'string' ? item : item?.path
    if (typeof value !== 'string' || value.trim() === '') continue
    const abs = resolve(value.trim())
    if (seen.has(abs)) continue
    seen.add(abs)
    out.push({
      path: abs,
      title: typeof item === 'object' && item !== null && typeof item.title === 'string' ? item.title : '',
      workspaceId: typeof item === 'object' && item !== null && typeof item.workspaceId === 'string' ? item.workspaceId : undefined,
    })
  }
  return out
}

/**
 * 解析目标根。
 *
 * 关键防线：工作区根解析结果**不得与用户级根相同**。DSH 的 web 进程 cwd 就是
 * 用户主目录，一旦 projectRoot 退化成主目录（面板没选工作区、会话 cwd 兜底），
 * `<主目录>/.dsh/skills` 与 `~/.dsh/skills` 就是同一个目录——「工作区级安装」
 * 会静默变成「用户级安装」，用户看到的就是「我选了工作区，怎么装到用户级了」。
 * 这里直接拒绝，让它报错而不是悄悄装错。
 *
 * @param {'user'|'workspace'} target
 * @param {string|undefined} projectRoot 工作区级必须给
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }}
 */
export function targetRoot(target, projectRoot) {
  if (target === 'user') return { ok: true, dir: userSkillsDir() }
  if (target === 'workspace') {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
      return { ok: false, error: '工作区级安装需要先选一个工作区' }
    }
    const dir = resolve(projectRoot, '.dsh', 'skills')
    const userDir = userSkillsDir()
    if (dir === userDir) {
      return {
        ok: false,
        error: `工作区 ${resolve(projectRoot)} 的技能根与用户级根是同一个目录（${userDir}），会装错地方；请选一个真正的工作区`,
      }
    }
    return { ok: true, dir }
  }
  return { ok: false, error: `未知目标根：${String(target)}（可用：${TARGET_KINDS.join(' / ')}）` }
}

/**
 * 列出全部已知技能根（每个工作区两个 + 用户级两个），带来源标记。
 *
 * 按目录去重：工作区的技能根若与用户级根撞在一起，丢掉工作区那份——
 * 那本来就不是一个独立的工作区根，留着会把用户级技能错标成某个工作区的。
 *
 * @param {undefined|string|object|Array<string|object>} workspaces
 */
export function allRoots(workspaces) {
  const list = normalizeWorkspaces(workspaces)
  const userDir = userSkillsDir()
  const roots = []
  const seen = new Set()
  const push = (root) => {
    if (seen.has(root.dir)) return
    seen.add(root.dir)
    roots.push(root)
  }

  for (const ws of list) {
    const title = ws.title !== '' ? ws.title : basename(ws.path)
    // 撞上用户级根的工作区不是真工作区根，跳过（用户级那份在后面会补上）。
    const dir = resolve(ws.path, '.dsh', 'skills')
    if (dir !== userDir) {
      push({ dir, kind: 'workspace', label: title, writable: true, projectRoot: ws.path, workspaceId: ws.workspaceId })
    }
    push({
      dir: resolve(ws.path, '.agents', 'skills'),
      kind: 'workspace-agents',
      label: `${title}(.agents)`,
      writable: false,
      projectRoot: ws.path,
      workspaceId: ws.workspaceId,
    })
  }

  push({ dir: userDir, kind: 'user', label: '用户级', writable: true })
  push({ dir: resolve(agentsHome(), 'skills'), kind: 'user-agents', label: '用户级(.agents)', writable: false })
  return roots
}

/**
 * 扫一个根下的技能（目录型 + 单文件型）。
 * @returns {object[]} 技能数组；不存在该根时返回空数组。
 */
export function scanRoot(root) {
  if (!isDir(root.dir)) return []
  const out = []
  for (const entry of listEntries(root.dir)) {
    if (entry.dir) {
      const read = readSkill(resolve(root.dir, entry.name), entry.name)
      if (read.ok) out.push(decorate(read.skill, root, entry.name))
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -3)
    const read = readFlatSkill(resolve(root.dir, entry.name), name)
    if (read.ok) out.push(decorate(read.skill, root, name))
  }
  return out
}

function decorate(skill, root, dirName) {
  // 启用状态从 SKILL.md 的 frontmatter 现读现算：面板显示什么，就跟 DSH 实际看到的一致。
  const frontmatter = readFrontMatterOf(skill.file)
  return {
    ...skill,
    rootKind: root.kind,
    rootLabel: root.label,
    rootDir: root.dir,
    // 工作区级技能要知道「属于哪个工作区」，光有 rootKind='workspace' 看不出是哪个。
    rootProjectRoot: root.projectRoot,
    rootWorkspaceId: root.workspaceId,
    writable: root.writable,
    installName: dirName,
    disabled: isDisabled(frontmatter),
    modelHiddenOnly: isModelHiddenOnly(frontmatter),
  }
}

/** 读一个 SKILL.md 的 frontmatter；读不到返回 null（当作「没停用」）。 */
function readFrontMatterOf(file) {
  if (typeof file !== 'string') return null
  try {
    return parseFrontMatter(readFileSync(file, 'utf8'))
  } catch (_error) {
    return null
  }
}

/**
 * 全部根的技能清单。
 *
 * 同名技能全部列出（含被遮蔽的那份），只标记 `shadowedBy`。
 * 早先是直接丢掉被遮蔽的那份——但面板要能管理每一个根里的技能，
 * 丢掉就意味着那个工作区里的副本看不见也删不掉。
 *
 * @param {undefined|string|object|Array<string|object>} workspaces
 * @returns {{ skills: object[], roots: object[] }}
 */
export function listSkills(workspaces) {
  const roots = allRoots(workspaces)
  const skills = []
  const firstOf = new Map()
  for (const root of roots) {
    for (const skill of scanRoot(root)) {
      const first = firstOf.get(skill.name)
      if (first !== undefined) {
        // 同名已被更高优先级的根提供：这一份 DSH 实际看不到，但仍在盘上。
        skill.shadowedBy = first.rootLabel
        skill.active = false
      } else {
        firstOf.set(skill.name, skill)
        skill.active = true
      }
      skills.push(skill)
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name) || a.rootDir.localeCompare(b.rootDir))
  return { skills, roots }
}

/** 目标根下是否已有同名技能。 */
export function existingSkill(dir, name) {
  if (isFile(resolve(dir, `${name}.md`))) return resolve(dir, `${name}.md`)
  if (isDir(resolve(dir, name))) return resolve(dir, name)
  return null
}
