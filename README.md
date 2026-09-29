# dsh-skill-installer

DSH 技能安装器：在设置页里**看**已有技能、**装**新技能、**导入**技能包、**管**（启用/停用/删除）技能。

- 面板位置：**设置 → 技能安装器**（设置左侧导航里的独立一项，与「思考强度」「提示缓存」同层）
- 模型工具：`skill_install`（`op=list / install / import / toggle / uninstall / roots`）

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

面板里的工作区是**下拉选择**：直接读 DSH 自己的工作区列表（第一项「用户级（不选工作区）」）；
读不到工作区时才退回手填路径。另外两个 `.agents/skills` 根只读显示，不会被本插件写入。

## 导入

面板「导入」区两条路：

- **选文件** —— 浏览器出于安全拿不到文件真实路径，所以由浏览器读字节、base64 传给宿主，宿主落临时文件后解包导入；
- **填绝对路径** —— 如 `/sdcard/Download/xxx.zip`，要求该路径在宿主上真实存在。

支持 `.md` 单文件、技能目录、`.zip`、`.tar`、`.tar.gz`。归档解到临时目录、装完即删；
归档里多包一层同名目录会自动剥掉。

## 技能管理

可写根里的每个技能有两个动作：

- **停用 / 启用** —— 改 `SKILL.md` 的 frontmatter（`disable-model-invocation: true` 与 `user-invocable: false`），
  **不搬文件、正文一字不动**，随时能开回来；
- **删除** —— 默认先备份到目标根的 `.backup/` 再删。

只读根（`.agents/skills`）的技能不给按钮，明确标注「只读根，不能改」。

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

1. **设置 → 技能安装器**（设置左侧导航里的独立一项）出现该页；
2. 工作区是下拉选择，能列出 DSH 自己的工作区；技能根显示两个目标根的真实路径；
3. 装一个技能后它出现在「技能管理」列表里，且 `~/.dsh/skills/<name>/SKILL.md` 真的存在；
4. 停用后卡片标「已停用」，`SKILL.md` 里出现 `disable-model-invocation: true`；启用后该字段消失、正文未变；
5. 导入一个 `.zip` 能装进技能；
6. 删除后目录消失，`.backup/` 里留有副本（未勾选不留备份时除外）。

## 已知边界

- 技能文件本身改动会被 DSH 的文件监听自动拾取；**宿主半**（本插件的 JS）改动需要重启 profile。
- 装 npm/GitHub 来源需要宿主能跑 `npm` / `git` / `tar`，命令超时 120s；归档解包需要 `unzip` / `tar`。
- 单个技能包超过 200 个文件会被拒绝（防呆，正常技能包远小于此）。
- frontmatter 解析只认 `key: value` 与布尔；技能头部够用，复杂 YAML 不支持。
- 面板的实际渲染效果尚未在真机肉眼验收（本机无障碍服务未开启，无法点按确认）。

## 许可

MIT
