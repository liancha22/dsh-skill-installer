/**
 * 子进程执行通道。
 *
 * 宿主注入 `subprocess` 服务时走它（与 dsh-mattpocock-skills-deck 同一写法）；
 * 拿不到服务时降级到 node:child_process —— 面板拉包这类操作在两种情况下都要能用。
 *
 * 只暴露一个 run(argv, opts)，调用方不关心底层是谁。
 */

import { spawn } from 'node:child_process'
import { EXEC_TIMEOUT_MS } from './constants.js'

/**
 * 造一个 runner。
 * @param {object|undefined} subprocess 宿主的 subprocess 服务（可为 undefined）
 * @param {object|undefined} timer 宿主的 timer 服务（可为 undefined）
 * @param {string} defaultCwd
 */
export function createRunner(subprocess, timer, defaultCwd) {
  return async function run(argv, opts = {}) {
    const cwd = opts.cwd ?? defaultCwd
    const timeoutMs = opts.timeoutMs ?? EXEC_TIMEOUT_MS
    if (subprocess !== undefined && typeof subprocess.spawn === 'function') {
      return runViaService(subprocess, timer, argv, cwd, timeoutMs)
    }
    return runViaNode(argv, cwd, timeoutMs)
  }
}

async function runViaService(subprocess, timer, argv, cwd, timeoutMs) {
  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8 * 1024 * 1024 },
        stderr: { maxBytes: 512 * 1024 },
      },
      graceMs: 2000,
    })
  } catch (error) {
    return { code: -1, stdout: '', stderr: `spawn 失败：${error.message}` }
  }
  let outcome
  try {
    outcome = timer !== undefined && typeof timer.timeout === 'function'
      ? await Promise.race([
        handle.done,
        timer.timeout(timeoutMs).then(() => {
          try { handle.terminate() } catch (_error) { /* 已退出 */ }
          return { exitCode: -1, signal: 'timeout' }
        }),
      ])
      : await handle.done
  } catch (error) {
    outcome = { exitCode: -1, signal: 'error' }
  }
  const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? ''
  const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? ''
  return { code: typeof outcome.exitCode === 'number' ? outcome.exitCode : -1, stdout, stderr }
}

function runViaNode(argv, cwd, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: `spawn 失败：${error.message}` })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timerId)
      resolvePromise({ code, stdout, stderr })
    }
    const timerId = setTimeout(() => {
      try { child.kill('SIGKILL') } catch (_error) { /* 已退出 */ }
      finish(-1)
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      stderr += String(error.message)
      finish(-1)
    })
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1))
  })
}
