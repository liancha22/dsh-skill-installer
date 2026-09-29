/**
 * 技能安装与卸载。
 *
 * 三条来源，统一收敛到「先落到一个暂存目录，校验通过再搬进目标根」：
 *   - local   ：本地目录（已解开的技能包，或单个技能目录）；
 *   - npm     ：`npm pack <包名>` 拉 tgz 再解开；
 *   - github  ：`git clone --depth 1` 拉仓库。
 *
 * 外部命令一律走宿主注入的 runner（面板/工具都传同一份），
 * 本文件不直接 import 子进程实现，便于以后换通道。
 */

import { cpSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { MAX_SKILL_FILES } from './constants.js'
import { existingSkill, targetRoot } from './roots.js'
import { findSkillsIn, readSkill } from './skillfile.js'
import { collectFiles, ensureDir, isDir, isFile, removeDir, safeJoin, timestamp } from './util.js'

/**
 * 装一个技能包。
 *
 * @param {object} opts
 * @param {'local'|'npm'|'github'} opts.source
 * @param {string} opts.ref 来源地址：本地路径 / npm 包名 / GitHub owner/repo[#ref]
 * @param {'user'|'workspace'} opts.target
 * @param {string|undefined} opts.projectRoot
 * @param {boolean|undefined} opts.overwrite 同名是否覆盖
 * @param {string|undefined} opts.only 只装这一个技能（技能包里有多个时）
 * @param {(argv: string[], opts?: object) => Promise<{code: number, stdout: string, stderr: string}>} opts.run
 * @returns {Promise<object>}
 */
export async function installSkills(opts) {
  const target = targetRoot(opts.target, opts.projectRoot)
  if (!target.ok) return { ok: false, error: target.error }
  const destRoot = target.dir

  const staged = await stage(opts)
  if (!staged.ok) return { ok: false, error: staged.error, log: staged.log }

  try {
    const scan = findSkillsIn(staged.dir)
    if (scan.found.length === 0) {
      return {
        ok: false,
        error: `没找到可用技能（需要 <技能名>/SKILL.md，且 frontmatter 有 name 与 description）`,
        detail: scan.errors.slice(0, 5),
        log: staged.log,
      }
    }
    const wanted = opts.only === undefined || opts.only === ''
      ? scan.found
      : scan.found.filter((skill) => skill.name === opts.only)
    if (wanted.length === 0) {
      return {
        ok: false,
        error: `技能包里没有名为 ${opts.only} 的技能`,
        available: scan.found.map((skill) => skill.name),
      }
    }

    ensureDir(destRoot)
    const installed = []
    const skipped = []
    for (const skill of wanted) {
      const files = collectFiles(skill.dir)
      if (files.length > MAX_SKILL_FILES) {
        skipped.push({ name: skill.name, reason: `文件数 ${files.length} 超过上限 ${MAX_SKILL_FILES}` })
        continue
      }
      const dest = safeJoin(destRoot, skill.name)
      if (dest === null) {
        skipped.push({ name: skill.name, reason: '目标路径非法' })
        continue
      }
      const clash = existingSkill(destRoot, skill.name)
      if (clash !== null && opts.overwrite !== true) {
        skipped.push({ name: skill.name, reason: '同名技能已存在（未开启覆盖）', path: clash })
        continue
      }
      if (clash !== null) backup(destRoot, skill.name, clash)
      rmSync(dest, { recursive: true, force: true })
      cpSync(skill.dir, dest, { recursive: true })
      const check = readSkill(dest, skill.name)
      if (!check.ok) {
        removeDir(dest)
        skipped.push({ name: skill.name, reason: `复制后校验失败：${check.error}` })
        continue
      }
      installed.push({ name: skill.name, description: check.skill.description, files: files.length, path: dest })
    }

    return {
      ok: installed.length > 0,
      target: destRoot,
      targetKind: opts.target,
      source: opts.source,
      ref: opts.ref,
      installed,
      skipped,
      log: staged.log,
      error: installed.length === 0 ? '没有任何技能被安装' : undefined,
    }
  } finally {
    if (staged.temp !== undefined) removeDir(staged.temp)
  }
}

/** 把来源拉到暂存目录。 */
async function stage(opts) {
  const log = []
  // 暂存目录放系统临时区，**不放工作区**：装技能不该在工作区里留痕迹，
  // 更不该因为工作区不可写而整个失败。
  const tempBase = tmpdir()
  const temp = safeJoin(tempBase, `${opts.source}-${timestamp()}-${process.pid}`)
  if (temp === null) return { ok: false, error: '暂存目录非法' }
  removeDir(temp)
  ensureDir(temp)

  if (opts.source === 'local') {
    const src = resolve(opts.ref)
    if (!isDir(src)) return { ok: false, error: `本地目录不存在：${src}`, temp, log }
    return { ok: true, dir: src, temp, log }
  }

  if (opts.source === 'npm') {
    const pack = await opts.run(['npm', 'pack', opts.ref, '--pack-destination', temp], { cwd: temp })
    log.push(`npm pack → exit ${pack.code}`)
    if (pack.code !== 0) return { ok: false, error: `npm pack 失败：${tail(pack.stderr)}`, temp, log }
    const tgz = readdirSync(temp).find((name) => name.endsWith('.tgz'))
    if (tgz === undefined) return { ok: false, error: 'npm pack 没有产出 tgz', temp, log }
    const untar = await opts.run(['tar', '-xzf', resolve(temp, tgz), '-C', temp], { cwd: temp })
    log.push(`tar -xzf → exit ${untar.code}`)
    if (untar.code !== 0) return { ok: false, error: `解包失败：${tail(untar.stderr)}`, temp, log }
    const pkgDir = resolve(temp, 'package')
    const root = isDir(pkgDir) ? pkgDir : temp
    return { ok: true, dir: skillsDirIn(root), temp, log }
  }

  if (opts.source === 'github') {
    const clone = await opts.run(['git', 'clone', '--depth', '1', opts.ref, resolve(temp, 'repo')], { cwd: temp })
    log.push(`git clone → exit ${clone.code}`)
    if (clone.code !== 0) return { ok: false, error: `git clone 失败：${tail(clone.stderr)}`, temp, log }
    return { ok: true, dir: skillsDirIn(resolve(temp, 'repo')), temp, log }
  }

  return { ok: false, error: `未知来源：${String(opts.source)}`, temp, log }
}

/**
 * 技能包根里技能可能放在 bundled-skills/ 或 skills/ 子目录（沿用 deck 的约定）。
 * 找不到子目录就用根目录本身。
 */
export function skillsDirIn(root) {
  for (const candidate of ['bundled-skills', 'skills']) {
    const dir = resolve(root, candidate)
    if (isDir(dir)) return dir
  }
  return root
}

/** 覆盖前把旧技能挪到备份目录，而不是直接删。 */
function backup(destRoot, name, path) {
  const backupDir = resolve(destRoot, '.backup')
  ensureDir(backupDir)
  const dest = safeJoin(backupDir, `${name}-${timestamp()}`)
  if (dest === null) return null
  try {
    if (isFile(path)) cpSync(path, `${dest}.md`)
    else cpSync(path, dest, { recursive: true })
    return dest
  } catch (_error) {
    return null
  }
}

/**
 * 卸载一个技能（只允许从可写根卸）。
 * @returns {{ ok: boolean, error?: string, path?: string, backup?: string|null }}
 */
export function uninstallSkill(opts) {
  const target = targetRoot(opts.target, opts.projectRoot)
  if (!target.ok) return { ok: false, error: target.error }
  return uninstallSkillAt(target.dir, opts.name, opts.keepBackup !== false)
}

/**
 * 从**已解析好的绝对根目录**卸载一个技能。
 *
 * 与 uninstallSkill 的差别：这里不再重新解析目标根。多个工作区下同名技能并存时，
 * 重新解析会指向别的根，删错地方——调用方（面板点的那张卡片）已经把准确路径给了。
 *
 * @param {string} dir 技能所在的根目录（绝对路径）
 * @param {string} name 技能名
 * @param {boolean} keepBackup 是否留备份
 */
export function uninstallSkillAt(dir, name, keepBackup) {
  const found = existingSkill(dir, name)
  if (found === null) return { ok: false, error: `目标根里没有技能 ${name}` }
  const saved = keepBackup === false ? null : backup(dir, name, found)
  try {
    rmSync(found, { recursive: true, force: true })
  } catch (error) {
    return { ok: false, error: `删除失败：${error.message}` }
  }
  return { ok: true, path: found, backup: saved, target: dir }
}

function tail(text) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-3).join(' | ')
}
