/**
 * 通用小工具：路径守卫、目录遍历、原子写、时间戳。
 *
 * 路径守卫是**唯一**允许拼技能落盘路径的地方——任何写盘都必须经 safeJoin，
 * 防止 `../` 之类把技能写到根目录外。
 */

import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** 把相对路径拼到 root 下，并确认结果没有逃出 root。逃出返回 null。 */
export function safeJoin(root, ...parts) {
  const target = resolve(root, ...parts)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

/** 目录存在且是目录。 */
export function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch (_error) {
    return false
  }
}

/** 文件存在且是文件。 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch (_error) {
    return false
  }
}

/**
 * 列出目录下的条目（不递归）。
 * @returns {{ name: string, dir: boolean }[]}；读不了返回空数组。
 */
export function listEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      dir: entry.isDirectory(),
    }))
  } catch (_error) {
    return []
  }
}

/** 递归收集目录下的文件相对路径（跳过 .git 与 node_modules）。 */
export function collectFiles(dir, prefix = '') {
  const out = []
  for (const entry of listEntries(dir)) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.dir) out.push(...collectFiles(resolve(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

/** 原子写：先写同目录临时文件再 rename，避免读到半截文件。 */
export function atomicWrite(path, text) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/** 建目录（已存在不报错）。 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** 删目录（不存在不报错）。 */
export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** 本地时间戳，用于备份名与日志。 */
export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 截断字符串到 n 个字符，超出加省略号。 */
export function truncate(text, n) {
  const s = String(text ?? '')
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}
