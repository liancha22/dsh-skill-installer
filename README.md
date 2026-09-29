# dsh-skill-installer

DSH 技能安装器：在设置页里**看**已有技能、**装**新技能、**卸**不用的技能。

- 面板位置：设置 → 插件 → **技能安装器**（独立页面，不占会话界面）
- 模型工具：`skill_install`（`op=list / install / uninstall / roots`）

## 装什么

技能必须是下面两种形状之一（与 DSH 自身的技能发现规则一致）：

```
技能包/
  some-skill/
    SKILL.md          # frontmatter 必须有 name 与 description
    任意资源文件…
```

或根目录直接放单文件 `some-skill.md`。技能名用 kebab-case（小写字母、数字、连字符）。

## 装到哪

| 目标根 | 路径 | 生效范围 |
| --- | --- | --- |
| 用户级（默认） | `~/.dsh/skills` | 所有会话可见 |
| 工作区级 | `<工作区>/.dsh/skills` | 只对该项目生效 |

面板里可以手填工作区路径（设置页没有会话上下文，留空则用宿主进程目录）。
另外两个 `.agents/skills` 根只读显示，不会被本插件写入。

## 三种来源

| 来源 | `ref` 写法 | 实际动作 |
| --- | --- | --- |
| `local` | 本地绝对路径 | 直接复制 |
| `npm` | 包名，如 `some-skills-deck` | `npm pack` → `tar -xzf` |
| `github` | `owner/repo` 或完整 URL | `git clone --depth 1` |

技能包里的技能放在 `bundled-skills/` 或 `skills/` 子目录时会被自动认出来；没有这两个子目录就用包根。

同名技能默认**不覆盖**；勾选「同名覆盖」后会先把旧的挪到目标根的 `.backup/` 下再装。
卸载默认也留备份，`skill_install{op:'uninstall', overwrite:true}` 才不留。

## 安装本插件

```bash
dsh plugin --profile web add github:liancha22/dsh-skill-installer
```

装完**重启该 profile**（`patchReload: startup`），然后刷新浏览器页面。

卸载：`dsh plugin --profile web remove dsh-skill-installer`，再重启。

## 验收判据

1. 设置 → 插件 里出现「技能安装器」页；
2. 页面能列出 `~/.dsh/skills` 下的技能，并显示两个目标根的真实路径；
3. 用 `local` 来源装一个技能后，该技能出现在列表里，且 `~/.dsh/skills/<name>/SKILL.md` 真的存在；
4. 重启 profile 后，新技能出现在会话的可用技能目录里，`skill` 工具能加载它；
5. 卸载后目录消失，`.backup/` 里留有副本（未勾选不留备份时除外）。

## 已知边界

- 技能文件本身改动会被 DSH 的文件监听自动拾取；**宿主半**（本插件的 JS）改动需要重启 profile。
- 装 npm/GitHub 来源需要宿主能跑 `npm` / `git` / `tar`，命令超时 120s。
- 单个技能包超过 200 个文件会被拒绝（防呆，正常技能包远小于此）。
- frontmatter 解析只认 `key: value` 与布尔；技能头部够用，复杂 YAML 不支持。

## 许可

MIT
