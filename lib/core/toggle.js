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
import { splitFrontMatter } from './skillfile.js'
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

  const lines = parsed.head.replace(/\r?\n$/, '').split(/\r?\n/).filter((line) => !isPolicyLine(line))
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  if (disabled) {
    lines.push(`${FIELD_MODEL}: true`)
    lines.push(`${FIELD_USER}: false`)
  }
  const nextHead = lines.join('\n')
  // 结束符一律重写成标准 `---`：若原文件是 `----` 这类损坏（本插件早期版本写坏的），
  // 这里顺带修回来，让 DSH 重新认得这个技能。
  //
  // `parsed.rest` 原样拼回，**不要剥掉开头的换行**：那个换行是 `---` 与正文之间的
  // 空行，剥掉就会悄悄改掉正文排版（往返切换后文件与原始不一致）。
  const next = `---\n${nextHead}${nextHead.endsWith('\n') ? '' : '\n'}---\n${parsed.rest}`
  if (next === text) return { ok: true, changed: false }
  try {
    atomicWrite(file, next)
  } catch (error) {
    return { ok: false, error: `写不了 ${file}：${error.message}` }
  }
  return { ok: true, changed: true, repaired: parsed.dashed === true }
}

/** 判断一行是不是停用相关字段（含大小写与空格差异）。 */
function isPolicyLine(line) {
  const key = line.split(':')[0].trim().toLowerCase()
  return key === FIELD_MODEL || key === FIELD_USER
}

/**
 * 只修 frontmatter 结束符（`----` → `---`），其它一个字节都不动。
 *
 * 这是给本插件早期版本写坏的文件准备的：那种文件 DSH 直接忽略，
 * 面板上看着「已启用」却根本不生效。修完 DSH 就能重新读到。
 *
 * @returns {{ ok: boolean, error?: string, changed?: boolean }}
 */
export function repairFrontMatter(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不了 ${file}：${error.message}` }
  }
  const parsed = splitFrontMatter(text)
  if (parsed === null) return { ok: false, error: `没有 YAML frontmatter：${file}` }
  if (parsed.dashed !== true) return { ok: true, changed: false }
  const next = `---\n${parsed.head.replace(/\r?\n$/, '')}\n---\n${parsed.rest}`
  try {
    atomicWrite(file, next)
  } catch (error) {
    return { ok: false, error: `写不了 ${file}：${error.message}` }
  }
  return { ok: true, changed: true }
}
