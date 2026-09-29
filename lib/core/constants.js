/**
 * dsh-skill-installer · 对外契约常量。
 *
 * 只放「改一处就影响多处」的名字：工具名、RPC 路径、来源与目标根的枚举。
 * 面板与宿主半都从这里取，避免两边各写一份字符串。
 */

export const PLUGIN_NAME = 'dsh-skill-installer'
export const TOOL_NAME = 'skill_install'
export const RPC_PATH = '/skill-installer-rpc'

/** 技能来源：自带包暂不做（用户裁定「先不放自带技能」），留枚举位便于以后加。 */
export const SOURCE_KINDS = ['local', 'npm', 'github']

/** 安装目标根：用户级全局可用，工作区级只对当前项目生效。 */
export const TARGET_KINDS = ['user', 'workspace']

/** 目标根的中文名，面板与工具输出共用。 */
export const TARGET_LABELS = {
  user: '用户级（全局）',
  workspace: '工作区级（当前项目）',
}

/** 来源的中文名。 */
export const SOURCE_LABELS = {
  local: '本地目录',
  npm: 'npm 包',
  github: 'GitHub 仓库',
}

/** 技能名语法：与 dsh-skill 的 SKILL_NAME 一致，kebab-case。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 技能描述上限：太长的 description 会污染技能目录，装的时候就截断。 */
export const MAX_DESCRIPTION = 300

/** 单个技能包允许的最大文件数，防呆（正常技能包远小于这个数）。 */
export const MAX_SKILL_FILES = 200

/** 外部命令超时（毫秒）。 */
export const EXEC_TIMEOUT_MS = 120000
