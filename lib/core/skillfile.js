/**
 * 技能文件的读取与校验。
 *
 * 技能有两种形状（与 dsh-skill-filesystem 一致）：
 *   1. 目录型：`<name>/SKILL.md` + 任意资源文件；
 *   2. 单文件型：根下直接放 `<name>.md`。
 *
 * 本文件只负责「读一个候选技能」，不做安装、不碰目标根。
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { MAX_DESCRIPTION, SKILL_NAME_RE } from './constants.js'
import { collectFiles, isDir, isFile, listEntries, truncate } from './util.js'

/** 极简 YAML frontmatter 解析：只认 `key: value` 与布尔，够技能头部用。 */
export function parseFrontMatter(text) {
  const raw = String(text ?? '')
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return null
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return null
  const head = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of head.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1)
    if (value === 'true') data[key] = true
    else if (value === 'false') data[key] = false
    else data[key] = value
  }
  return { data, body }
}

/** 目录型技能的候选路径：<dir>/SKILL.md。 */
export function skillFileIn(dir) {
  const path = resolve(dir, 'SKILL.md')
  return isFile(path) ? path : null
}

/**
 * 读一个技能候选，校验 name/description。
 * @returns {{ ok: true, skill: object } | { ok: false, error: string }}
 */
export function readSkill(dir, fallbackName) {
  const file = skillFileIn(dir)
  if (file === null) return { ok: false, error: `缺少 SKILL.md：${dir}` }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不了 SKILL.md：${error.message}` }
  }
  const parsed = parseFrontMatter(text)
  if (parsed === null) return { ok: false, error: `SKILL.md 没有 YAML frontmatter：${file}` }
  const name = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : ''
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
  if (name === '') return { ok: false, error: `frontmatter 缺 name：${file}` }
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, error: `技能名必须是 kebab-case（小写字母/数字/连字符）：${name}` }
  }
  if (fallbackName !== undefined && fallbackName !== name) {
    return { ok: false, error: `目录名与技能名不一致：目录 ${fallbackName} / name ${name}` }
  }
  if (description === '') return { ok: false, error: `frontmatter 缺 description：${file}` }
  return {
    ok: true,
    skill: {
      name,
      description: truncate(description, MAX_DESCRIPTION),
      file,
      dir: resolve(dir),
      files: collectFiles(dir).length,
    },
  }
}

/** 单文件型技能：<root>/<name>.md。 */
export function readFlatSkill(path, name) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不了技能文件：${error.message}` }
  }
  const parsed = parseFrontMatter(text)
  if (parsed === null) return { ok: false, error: `没有 YAML frontmatter：${path}` }
  const declared = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : name
  const description = typeof parsed.data.description === 'string' ? parsed.data.description.trim() : ''
  if (!SKILL_NAME_RE.test(declared)) return { ok: false, error: `技能名不合法：${declared}` }
  if (description === '') return { ok: false, error: `frontmatter 缺 description：${path}` }
  return {
    ok: true,
    skill: {
      name: declared,
      description: truncate(description, MAX_DESCRIPTION),
      file: path,
      dir: null,
      files: 1,
    },
  }
}

/** 一个目录里可能装着多个技能（技能包）；返回找到的全部候选。 */
export function findSkillsIn(root) {
  const found = []
  const errors = []
  for (const entry of listDirs(root)) {
    const read = readSkill(entry, basename(entry))
    if (read.ok) found.push(read.skill)
    else errors.push(read.error)
  }
  // 根目录本身就是技能的情况。
  if (found.length === 0 && isFile(resolve(root, 'SKILL.md'))) {
    const read = readSkill(root)
    if (read.ok) found.push(read.skill)
    else errors.push(read.error)
  }
  return { found, errors }
}

/** 列出一个技能包根下的子目录（每个子目录是一个技能候选）。 */
function listDirs(root) {
  if (!isDir(root)) return []
  return listEntries(root)
    .filter((entry) => entry.dir)
    .map((entry) => resolve(root, entry.name))
}
