/**
 * 面向前端的偏好持久化。
 *
 * 存在 `~/.dsh-tui/config.json`，**与 harness 自己的状态（`~/.dsh/`）分开**：
 * 这些是「这个终端前端怎么用」的偏好，不是会话数据。会话的真相永远在
 * `~/.dsh/sessions/` 的日志里，这里丢了也不影响任何一次对话。
 *
 * 所有读写都容错：文件损坏、目录不可写、字段类型不对——一律退回默认值，
 * 绝不让「记不住上次用的模型」这种事把启动搞挂。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 默认存放位置，可用 DSH_TUI_HOME 覆盖（测试与多份配置用）。 */
export function defaultConfigDir(env = process.env) {
  return env.DSH_TUI_HOME ?? path.join(os.homedir(), '.dsh-tui')
}

/** 默认偏好。 */
function defaults() {
  return {
    /** 上次用的模型路由，形如 `provider/model`。 */
    model: undefined,
    /** 上次用的 provider。 */
    provider: undefined,
    /** 上次选的主题 id（THEMES 的键）。 */
    theme: undefined,
  }
}

/** 只保留认识的字段，并做类型校验。 */
function sanitize(raw) {
  const out = defaults()
  if (raw === null || typeof raw !== 'object') return out
  if (typeof raw.model === 'string' && raw.model !== '') out.model = raw.model
  if (typeof raw.provider === 'string' && raw.provider !== '') out.provider = raw.provider
  if (typeof raw.theme === 'string' && raw.theme !== '') out.theme = raw.theme
  if (['auto', 'on', 'off'].includes(raw.paneMode)) out.paneMode = raw.paneMode
  return out
}

/**
 * 创建偏好存储。
 * @param {{dir?:string}} [options]
 */
export function createPrefs({ dir = defaultConfigDir() } = {}) {
  const file = path.join(dir, 'config.json')

  function read() {
    try {
      const text = fs.readFileSync(file, 'utf8')
      return sanitize(JSON.parse(text))
    } catch {
      // 文件不存在 / 损坏 / 无权限：一律当默认值。
      return defaults()
    }
  }

  /**
   * 写入偏好。
   *
   * @returns {{ok:boolean, value:object}} `ok` 如实反映**是否真的落盘**。
   *   早期版本无论成败都返回新值，调用方于是告诉用户「已记住」——那是假成功。
   */
  function write(patch) {
    const next = sanitize({ ...read(), ...patch })
    let ok = false
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      // mode 只在**新建**时生效；已存在的文件不会被收紧，显式改一次。
      try {
        fs.chmodSync(file, 0o600)
      } catch {
        // 平台不支持 chmod（Windows）不算失败。
      }
      ok = true
    } catch {
      ok = false
    }
    return { ok, value: next }
  }

  return { file, read, write }
}
