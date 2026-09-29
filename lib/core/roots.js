/**
 * 技能根解析与清单。
 *
 * 目标根（本插件可写的）：
 *   - 用户级：`~/.dsh/skills`（与 dsh-skill-filesystem 的 user-dsh 根同一处）；
 *   - 工作区级：`<项目根>/.dsh/skills`（与 project-dsh 根同一处）。
 *
 * 只读探测另外两个根（用户/项目的 .agents/skills），因为技能可能装在那里，
 * 面板要如实显示「这个技能是从哪来的」。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
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

/**
 * 解析目标根。
 * @param {'user'|'workspace'} target
 * @param {string|undefined} projectRoot 工作区级必须给
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }}
 */
export function targetRoot(target, projectRoot) {
  if (target === 'user') return { ok: true, dir: resolve(dshHome(), 'skills') }
  if (target === 'workspace') {
    if (typeof projectRoot !== 'string' || projectRoot === '') {
      return { ok: false, error: '工作区级安装需要先知道当前项目根目录' }
    }
    return { ok: true, dir: resolve(projectRoot, '.dsh', 'skills') }
  }
  return { ok: false, error: `未知目标根：${String(target)}（可用：${TARGET_KINDS.join(' / ')}）` }
}

/**
 * 列出全部已知技能根（含只读的 .agents 根），带来源标记。
 * @param {string|undefined} projectRoot
 */
export function allRoots(projectRoot) {
  const roots = [
    { dir: resolve(dshHome(), 'skills'), kind: 'user', label: '用户级', writable: true },
  ]
  if (typeof projectRoot === 'string' && projectRoot !== '') {
    roots.unshift({ dir: resolve(projectRoot, '.dsh', 'skills'), kind: 'workspace', label: '工作区级', writable: true })
  }
  roots.push({ dir: resolve(agentsHome(), 'skills'), kind: 'user-agents', label: '用户级(.agents)', writable: false })
  if (typeof projectRoot === 'string' && projectRoot !== '') {
    roots.push({ dir: resolve(projectRoot, '.agents', 'skills'), kind: 'workspace-agents', label: '工作区级(.agents)', writable: false })
  }
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
 * 全部根的技能清单，同名技能标记冲突（先出现的优先，与 rank 顺序一致：工作区级优先）。
 * @returns {{ skills: object[], roots: object[] }}
 */
export function listSkills(projectRoot) {
  const roots = allRoots(projectRoot)
  const skills = []
  const seen = new Map()
  for (const root of roots) {
    for (const skill of scanRoot(root)) {
      const first = seen.get(skill.name)
      if (first !== undefined) {
        skill.shadowedBy = first.rootKind
        continue
      }
      seen.set(skill.name, skill)
      skills.push(skill)
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills, roots }
}

/** 目标根下是否已有同名技能。 */
export function existingSkill(dir, name) {
  if (isFile(resolve(dir, `${name}.md`))) return resolve(dir, `${name}.md`)
  if (isDir(resolve(dir, name))) return resolve(dir, name)
  return null
}
