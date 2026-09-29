/**
 * 导入：从用户选定的文件/归档装技能。
 *
 * 支持四种输入（按路径自动判类型）：
 *   - `.md` 单文件          → 当单文件型技能装；
 *   - 目录                  → 当技能包/单个技能装（走 install.js 的 local 来源）；
 *   - `.zip`                → 解压后再按技能包装；
 *   - `.tar` / `.tar.gz` / `.tgz` → 解包后再按技能包装。
 *
 * 归档一律解到临时目录，装完即删——不把中间产物留在用户目录里。
 */

import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, resolve } from 'node:path'
import { findSkillsIn, readFlatSkill, readSkill } from './skillfile.js'
import { installSkills } from './install.js'
import { existingSkill, targetRoot } from './roots.js'
import { ensureDir, isDir, isFile, removeDir, safeJoin, timestamp } from './util.js'

/** 这个路径看起来是不是归档。 */
export function isArchive(path) {
  const lower = String(path).toLowerCase()
  return lower.endsWith('.zip') || lower.endsWith('.tar') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')
}

/**
 * 导入入口。
 *
 * @param {object} opts
 * @param {string} opts.path 用户选的路径（文件或目录）
 * @param {'user'|'workspace'} opts.target
 * @param {string|undefined} opts.projectRoot
 * @param {boolean|undefined} opts.overwrite
 * @param {(argv: string[], o?: object) => Promise<{code:number,stdout:string,stderr:string}>} opts.run
 * @returns {Promise<object>}
 */
export async function importPath(opts) {
  const path = resolve(String(opts.path ?? ''))
  if (path === '') return { ok: false, error: '没有给路径' }
  if (!isFile(path) && !isDir(path)) return { ok: false, error: `路径不存在：${path}` }

  if (isDir(path)) {
    return installSkills({ ...opts, source: 'local', ref: path })
  }
  if (isArchive(path)) {
    return importArchive({ ...opts, path })
  }
  if (extname(path).toLowerCase() === '.md') {
    return importSingleFile({ ...opts, path })
  }
  return { ok: false, error: `认不出的文件类型：${basename(path)}（支持 .md / .zip / .tar / .tar.gz / 目录）` }
}

/** 单文件技能：复制成 <目标根>/<name>.md。 */
function importSingleFile(opts) {
  const name = basename(opts.path).replace(/\.md$/i, '')
  const read = readFlatSkill(opts.path, name)
  if (!read.ok) return { ok: false, error: read.error }
  const target = targetRoot(opts.target, opts.projectRoot)
  if (!target.ok) return { ok: false, error: target.error }
  ensureDir(target.dir)
  const clash = existingSkill(target.dir, read.skill.name)
  if (clash !== null && opts.overwrite !== true) {
    return { ok: false, error: `同名技能已存在：${clash}（未开启覆盖）` }
  }
  if (clash !== null) removeDir(clash)
  const copied = copySingleSkill(opts.path, target.dir, read.skill.name)
  if (!copied.ok) return copied
  return {
    ok: true,
    target: target.dir,
    targetKind: opts.target,
    source: 'file',
    ref: opts.path,
    installed: [{ name: read.skill.name, description: read.skill.description, files: 1, path: copied.path }],
    skipped: [],
  }
}

/** 归档：解到临时目录，再当技能包装。 */
async function importArchive(opts) {
  // 解包用系统临时区，别在工作区里建目录（工作区可能不可写，也不该留痕迹）。
  const tempBase = safeJoin(tmpdir(), 'dsh-skill-installer')
  if (tempBase === null) return { ok: false, error: '临时目录非法' }
  ensureDir(tempBase)
  const temp = safeJoin(tempBase, `import-${timestamp()}-${process.pid}`)
  if (temp === null) return { ok: false, error: '临时目录非法' }
  removeDir(temp)
  ensureDir(temp)

  try {
    const unpacked = await unpack(opts.path, temp, opts.run)
    if (!unpacked.ok) return { ok: false, error: unpacked.error, log: unpacked.log }
    const root = unpacked.dir
    const scan = findSkillsIn(root)
    if (scan.found.length === 0) {
      return { ok: false, error: '归档里没找到技能（需要 <技能名>/SKILL.md 且 frontmatter 有 name 与 description）', detail: scan.errors.slice(0, 5) }
    }
    const result = await installSkills({ ...opts, source: 'local', ref: root })
    return { ...result, importedFrom: basename(opts.path), unpackLog: unpacked.log }
  } finally {
    removeDir(temp)
  }
}

/** 按扩展名选解包命令。 */
async function unpack(path, temp, run) {
  const log = []
  const lower = path.toLowerCase()
  let argv
  if (lower.endsWith('.zip')) argv = ['unzip', '-q', '-o', path, '-d', temp]
  else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) argv = ['tar', '-xzf', path, '-C', temp]
  else argv = ['tar', '-xf', path, '-C', temp]

  const out = await run(argv, { cwd: temp })
  log.push(`${argv[0]} → exit ${out.code}`)
  if (out.code !== 0) return { ok: false, error: `解包失败：${tail(out.stderr)}`, log }

  // 归档里常见「多一层同名目录」，剥掉它。
  const entries = readdirSync(temp).filter((name) => name !== '.DS_Store')
  if (entries.length === 1) {
    const only = resolve(temp, entries[0])
    try {
      if (statSync(only).isDirectory()) return { ok: true, dir: only, log }
    } catch (_error) { /* 保持 temp */ }
  }
  return { ok: true, dir: temp, log }
}

function tail(text) {
  return String(text ?? '').trim().split(/\r?\n/).slice(-3).join(' | ')
}

/** 单文件技能直接落到目标根（给面板的 .md 导入用）。 */
export function copySingleSkill(file, destRoot, name) {
  const dest = safeJoin(destRoot, `${name}.md`)
  if (dest === null) return { ok: false, error: '目标路径非法' }
  try {
    copyFileSync(file, dest)
  } catch (error) {
    return { ok: false, error: `复制失败：${error.message}` }
  }
  const check = readFlatSkill(dest, name)
  if (!check.ok) return { ok: false, error: `复制后校验失败：${check.error}` }
  return { ok: true, path: dest, name }
}

/** 目录型技能的直接校验（给「导入目录」预览用）。 */
export function peekSkill(path) {
  if (isDir(path)) return readSkill(path)
  if (isFile(path)) return readFlatSkill(path, basename(path).replace(/\.md$/i, ''))
  return { ok: false, error: `路径不存在：${path}` }
}
