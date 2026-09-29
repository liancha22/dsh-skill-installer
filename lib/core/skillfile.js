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

/**
 * 把文本拆成 frontmatter 头与正文。
 *
 * 分隔符判定必须与 dsh-skill-filesystem 的 parseFrontmatter **逐字一致**：
 * 起始行与结束行都要**整行精确等于 `---`**。
 *
 * 早先这里用 `indexOf('\n---', 3)`，那是错的——它能匹配上 `\n----`，
 * 于是「四个横线」这种损坏文件我这边认、DSH 那边不认：自测全绿，真机读不到。
 * 解析器必须比被解析方严格，绝不能更宽松。
 *
 * @param {string} text
 * @returns {{ head: string, rest: string, dashed: boolean } | null}
 *   head 为 `---` 之间的原文（含结尾换行）；rest 为结束行之后的全部原文；
 *   dashed 表示结束行不是标准 `---`（是 `----` 这类损坏），需要修复。
 */
export function splitFrontMatter(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '')
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return null
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return null

  let lineStart = firstLineEnd + 1
  // 先找严格 `---`；找不到再认「三个以上横线」这种损坏，好让调用方把它修回来。
  let fallback = null
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---' || /^-{3,}$/.test(line)) {
      const hit = {
        head: raw.slice(firstLineEnd + 1, lineStart),
        rest: nextNewline < 0 ? '' : raw.slice(nextNewline + 1),
        dashed: line !== '---',
      }
      if (line === '---') return hit
      if (fallback === null) fallback = hit
    }
    if (nextNewline < 0) break
    lineStart = nextNewline + 1
  }
  return fallback
}

/** 极简 YAML frontmatter 解析：只认 `key: value` 与布尔，够技能头部用。 */
export function parseFrontMatter(text) {
  const split = splitFrontMatter(text)
  if (split === null) return null
  const data = {}
  for (const line of split.head.split(/\r?\n/)) {
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
  // `dashed: true` 表示结束符不是标准 `---`——本插件能认（好把它修回来），
  // 但 DSH 会**直接忽略**这个技能。调用方必须把这个差别透出去，不能让面板假装它正常。
  return { data, body: split.rest.replace(/^\r?\n/, ''), dashed: split.dashed }
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
      // 结束符坏了：DSH 读不到这个技能，面板要标出来并允许一键修。
      brokenFrontMatter: parsed.dashed === true,
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
      // 结束符坏了：DSH 读不到这个技能，面板要标出来并允许一键修。
      brokenFrontMatter: parsed.dashed === true,
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
