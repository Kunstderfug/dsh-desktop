# Harness 0.2.1-rc.2 兼容升级

本文保留依赖升级阶段的审计和验收记录。后续稳定性工作见
[0.12.1 稳定性修复清单](0.12.1-stability-fix-checklist.md)：新增 settings 写入校验，
当前补丁总数为 31；该阶段的变更和验收结果另列于清单中。

## 基线与范围

Desktop 版本保持 `0.12.1`，Harness 从 `0.2.1-rc.1` 升至 npm 发布的
`0.2.1-rc.2`。上游 tag 为 `dsh-v0.2.1-rc.2`，提交
`687f282e8625c6b8d11ff58211a90524be2e4317`。

根 manifest、Office 精确 peer 和锁文件同步升级。锁文件中 303 个 Harness 包
全部固定 rc.2；其余宿主插件已有的 `^0.2.1-rc.1` 区间接受 rc.2，继续保留。
Cordis、Electron、LibreOffice Kit 和其他第三方依赖保持原锁定版本。
六份 README 与开发指南同步当前基线，rc.1 升级记录保留为历史。

上游主要新增 DeepSeek Search/Fetch API 选择开关与临时 1017 模型徽标。
`dsh-web-deepseek-api`、`dsh-client-ui-deepseek-model-label-1017` 随官方 bundle
进入传递闭包，不提升为 Desktop 直接依赖。默认仍使用 Messages 搜索和 HTTP 抓取。

本次覆盖 Profile 组合、后端加载、客户端发现、HTML 引导和客户端激活。
普通 Profile 仍从 Profile 入口解析插件，明确的宿主 peer fallback 与 Safe Mode
安装资源 anchor 均沿用原规则。中立 launch-root 不承担依赖解析；原始 cause、阶段
诊断和恢复入口继续由原宿主实现保留。本次没有改动加载器或启动协议。

## 补丁审计

分别提取旧版原始发布包、当前已打补丁文件和新版原始发布包，逐项比较 25 个
Harness 补丁涉及的全部 65 个文件。23 个包的目标文件在归一版本号后完全一致；
另外两个包只有构建标识变化：

| 包 | rc.2 原始文件差异 | 处理 |
| --- | --- | --- |
| dsh-client-modules | lib/index.js 中 release commit 从 ed75efe 变为 332895e | 保留 rc.2 标识及全部宿主解析、隔离补丁 |
| dsh-client-ui-sidebar | lib/client.js 中版本与 commit 标识更新 | 保留 rc.2 标识及全部导航、布局补丁 |
| 其余 23 个 Harness 补丁包 | 目标文件无功能变化 | 保留原补丁行为，迁移到 rc.2 文件名 |
| cordis-plugin-loader 1.0.6、libreoffice-kit 0.1.5、pi-ai 1.3.0、node-pty 1.2.0-beta.15、undici 8.11.2 | 锁定版本未变 | 保留五个补丁 |

没有发现可删除的功能 hunk。具体职责、回归入口和移除条件沿用
[rc.1 审计清单](harness-0.2.1-rc.1-upgrade.md)。`dsh` manifest 补丁中的
Harness 版本同步 rc.2。安装后再次比较所有 65 个目标文件，除版本/构建标识外，
与旧版已打补丁文件完全一致；最终仍为 30 个 patch。

## 验证结果

2026-10-19，macOS arm64：

- 干净 `npm ci --no-audit --no-fund` 完成：30/30 补丁、品牌资源与 Electron
  postinstall 全部成功。
- `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 完整 `npm test`：214 文件、2159 用例全部通过，包含真实子进程启动、普通及
  本地链接插件、缺少宿主 peer、Safe Mode、客户端 bootstrap 执行注册和包闭包回归。
- `node scripts/verify-target.mjs darwin arm64` 通过：Electron 43.0.0 / Node
  24.17.0 可以加载 Harness 原生 loader。
- `node scripts/probe-electron-node-runtime.mjs` 通过：临时 Profile、Electron
  Node 模式启动、认证 cookie 与 HTML 200。
- 使用独立开发 Profile 启动实际 Electron 应用，确认专用 userData、DSH_HOME
  和中立 launch-root。macOS UtilityProcess 就绪，原生 renderer 已挂载主界面、
  Standard mode、PPT/Word/Excel 入口；设置显示 `0.2.1-rc.2`。
- 对该独立 Profile 验证 session/list：未认证 401，认证后 200。
- 使用 tabbit 检查真实浏览器，完成主界面、设置与插件页加载；新版 Web Search API
  开关默认关闭，开启并保存后显示 Search/Fetch 地址与结果数，刷新后仍保留；
  再关闭保存恢复 Messages 默认配置。截图已检查，操作期间无 pageerror。

变动测试为 `release.test.ts` 和 `session-delete-patch.test.ts`。前者同步基线，
新增整个 Harness 闭包版本一致性及新增官方包不被直接提升的断言；后者同步补丁
文件版本，保留原删除行为验证。完整回归首次仅因六份 README 版本过期失败，
同步文档后重跑全套成功。

未完成 Windows 原生验证、签名安装包/安装升级、真实模型及 Search/Fetch API
请求、第三方市场插件组合与全部 slot 的视觉组合验收。当前安装应用未被替换，
真实用户 Profile 未修改，也未提交、推送或发布。

## Inspector 限制

rc.2 的 `dsh-experimental-inspector` 仍拒绝 `globalThis.fetch` 访问器。
此前定位到的 Billion Context fetch guard 冲突不会因本次依赖升级自动消失；
本次未加入该问题的独立修复或改动用户插件配置。

## 合并后兼容收敛（2026-10-19/20，分支 `feat/harness-0.2.1-rc.2`）

在 fork 升级提交（`f85f342`）合入本仓库后，对本仓库持有的 multitask 宿主插件与
检查脚本按 0.2.1 运行时语义做了一次收敛，并修复了一个仅在真实 0.2.1 运行中
暴露的缺陷。以下改动均为本仓库自有代码的适配，不新增第三方补丁。

### guardrails 包装层叠加修复（关键）

- 根因：0.2.1 cordis 的 `ctx.get(name)` 每次调用返回一个新的 callable proxy
  （隔离探针确认 `a === b` 为 false，但属性写入会持久到底层服务实例）。
  `packages/dsh-multitask/guardrails.js` 原用 `WeakSet` 按 `ctx.get('subagents')`
  结果做已包装去重，proxy 身份每次不同导致去重永不命中：每次 `agent/created`
  都在 `startActivation`（及 `tools.execute`）上再叠一层包装，一层套一层。
- 表现：一次成功激活触发 N 次 `onWriterStart`，任务卡会话日志出现 N 条重复
  `multitask/phase(writing)`。实测一次真实运行累积到 109 层，109 条事件在
  5 ms 内连续追加（同一 childId、每毫秒一条）。
- 修复：改用安装函数上的 `Symbol` 标记去重。属性写入持久到服务实例，标记
  跨 proxy 重建仍然命中；`ensureWrapped` 重复调用与重复 `agent/created` 不再
  叠层。修复后隔离探针（109 次 `ensureWrapped` + 1 次激活）只回调 1 次。
- 其余 WeakSet/WeakMap 用法逐一核对：键均为 exec 或 session 对象（
  `claims-guard.js`、`claims.js`、`orchestrator-mode.js`、`guardrails.js`
  的 `pendingByExec`），不受 proxy 身份影响。

### 其他收敛修复

- `claims.js`：0.2.1 下 `ctx.get` 在提供 fiber 未激活时可能返回 `undefined`，
  重启恢复路径的 `void service.reconcile(...)` 曾以未处理 rejection 崩溃；
  现按“可忽略清理错误”约定以带注释的 `.catch(() => {})` 吞掉该瞬时不可用。
- `check-multitask-hardening.mjs`：compose 顺序里 `push('working-directory', …)`
  参数次序按新 core 契约修正。
- `check-multitask-claims.mjs`：改用 0.2.1 的 `listDescendants`（ enriched 遍历）
  断言子代理状态，替代仅返回持久化行的 `listChildren`。
- `check-multitask-mount.mjs`：浏览器内占位符自上游 #11（`5963df7`）起恒被
  claim 层占据，`data-dsh-multitask-placeholder` 在浏览器中不可达；断言目标
  改为实际占据者 `[data-dsh-multitask-claim-layer]`。这是既有契约变化，
  非 0.2.1 回归，测试未放宽。
- `check-multitask-command.mjs`：同步 0.2.1 会话持久化契约。会话记录自
  `session.v3.jsonl` 升级为 `session.v4.jsonl.zstd`（`sessionFormatVersion: 4`），
  文件发现按 v3/v4 后缀同时匹配；0.2.1 的 jsonl 写入端缓冲激进，仅在显式
  `ctx.sessions.flush()` 路径（提醒投递、标题流）与 teardown 时强制落盘，
  运行中读取不再保证可见本次事件，因此 busy-turn 的完整持久顺序断言
  （ingress → `turn/start` → `user/message` → command/run → multitask/task →
  command/done → `turn/end`）移到 teardown 强制 drain 之后的阶段 4 执行，
  运行中只保留 `turnRunning` 等 UI 证据与活模型要求。日志定位改为匹配
  `command/run` 记录（researcher 子会话同样引用目标文本但不会记录
  command/run）；busy 窗口归因与 model 可见面泄漏断言按 0.2.1 的
  "Agent … sent a message" 子代理回传（设计的下轮 fold 机制）做窗口与
  relay 豁免：逐字命令行仍绝对禁止出现在 model 可见面，researcher 子会话
  转发的目标引用不属于命令泄漏。断言均对应真实契约变化，未放宽。

### 本次验证（macOS arm64，普通 Node 子进程执行）

- `npm ci` 后补丁重放通过；`npm run typecheck` 通过。
- multitask 检查全部实跑通过：guardrails、claims（3 项）、hardening（7 场景）、
  mount、researcher、claim-enforcement、orchestrator-mode、round-driver、
  command（含 busy-turn 公共缝、attachment 公共缝与阶段 4 持久顺序断言）。
  task-card 检查除既有失败外全部通过：第二个键控卡片到达终态 `failed` 的
  等待在 `88f89f0` 收紧断言（`failed === true && phase === 'failed'`）后即已
  失败，非 0.2.1 回归；本次重跑其余分段（键控卡片、chip rail、researching
  子代理、claim badge、narrow 卡）均通过。
- 完整 `npm test`：2511 项中 2509 项通过；既有环境性失败 2 项
  （`test/electron-node-loader.test.ts`、`test/ppt-windows-font-layout.test.mjs`），
  与升级前 0.1.3 kit 基线（`/tmp/kit013`）失败一致，非本次引入。
- `git diff --check` 通过。未做 UI/Electron 人工验收，未验证 Windows 与
  安装包。

### 一次性环境事件（非回归）

- 一次 task-card 重跑因 `office:prepare` 清理旧 `.build/office-runtime` 时
  `rmdir` 撞上仍在收尾的上一个 dev office worker（ENOTEMPTY）而启动失败；
  确认无进程持有该目录后重跑通过。该目录为 git 忽略的构建产物。
