/**
 * 技能的启用 / 停用。
 *
 * 用 DSH 自己的 frontmatter 字段，而不是搬走文件：
 *   - `disable-model-invocation: true` —— 模型看不到、不能自动调用；
 *   - `user-invocable: false`          —— 用户也不能显式调用。
 *
 * 两个都写 = 彻底停用（谁都用不了，但文件还在、随时能开回来）。
 * 开启 = 把这两个字段删掉，恢复到「默认可用」。
 *
 * 判定规则与 dsh-skill-filesystem 的 parseInvocationPolicy 一致：
 *   缺省 modelInvocable = true、userInvocable = true。
 */

import { readFileSync } from 'node:fs'
import { atomicWrite } from './util.js'

const FIELD_MODEL = 'disable-model-invocation'
const FIELD_USER = 'user-invocable'

/** 技能是否处于「停用」状态（两个字段任一表示不可用即算停用）。 */
export function isDisabled(frontmatter) {
  const data = frontmatter?.data ?? {}
  return data[FIELD_MODEL] === true || data[FIELD_MODEL] === 'true' || data[FIELD_USER] === false || data[FIELD_USER] === 'false'
}

/** 技能是否「仅模型不可见」但用户仍可显式调用。 */
export function isModelHiddenOnly(frontmatter) {
  const data = frontmatter?.data ?? {}
  const model = data[FIELD_MODEL] === true || data[FIELD_MODEL] === 'true'
  const user = data[FIELD_USER] === false || data[FIELD_USER] === 'false'
  return model && !user
}

/**
 * 改写 SKILL.md 的 frontmatter，加/删停用字段。
 *
 * 只在头部增删行，**正文一字不动**；已有的其他字段保持原顺序与原文。
 *
 * @param {string} file SKILL.md 的绝对路径
 * @param {boolean} disabled true=停用，false=启用
 * @returns {{ ok: boolean, error?: string, changed?: boolean }}
 */
export function setDisabled(file, disabled) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不了 ${file}：${error.message}` }
  }
  const parsed = splitFrontMatter(text)
  if (parsed === null) return { ok: false, error: `没有 YAML frontmatter：${file}` }

  const lines = parsed.head.split(/\r?\n/).filter((line) => !isPolicyLine(line))
  if (disabled) {
    lines.push(`${FIELD_MODEL}: true`)
    lines.push(`${FIELD_USER}: false`)
  }
  const nextHead = lines.join('\n')
  const next = `---\n${nextHead}${nextHead.endsWith('\n') ? '' : '\n'}---${parsed.rest}`
  if (next === text) return { ok: true, changed: false }
  try {
    atomicWrite(file, next)
  } catch (error) {
    return { ok: false, error: `写不了 ${file}：${error.message}` }
  }
  return { ok: true, changed: true }
}

/** 判断一行是不是停用相关字段（含大小写与空格差异）。 */
function isPolicyLine(line) {
  const key = line.split(':')[0].trim().toLowerCase()
  return key === FIELD_MODEL || key === FIELD_USER
}

/** 把文本拆成 frontmatter 头 + 其余部分（保留 `---` 之后的原文）。 */
function splitFrontMatter(text) {
  const normalized = String(text ?? '').replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return null
  const end = normalized.indexOf('\n---', 3)
  if (end < 0) return null
  return {
    head: normalized.slice(normalized.indexOf('\n') + 1, end),
    rest: normalized.slice(end + 3),
  }
}
