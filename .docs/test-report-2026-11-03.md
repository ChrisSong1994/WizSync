# WizSync 测试报告（2026-11-03）

> **状态更新（同日）**：本报告第四节列出的 5 个问题已全部修复并补充回归测试，
> 详见文末「七、修复记录」。

> 测试对象：WizSync v1.1.6（分支 `main`，提交 `69fdff3`）
> 环境：macOS 15.2 / Apple M1 Pro / Node 26.3 / Electron 29.4.6 / Unison 2.53.8（内置 darwin-arm64）
> 覆盖层次：单元测试 → 真实 Unison 集成测试 → 主进程 IPC → 真实 Electron 端到端（开发 + 打包）

---

## 一、结论摘要

| 层级 | 用例数 | 结果 |
|---|---|---|
| 原有单元测试（vitest） | 94 | 全部通过 |
| **新增：真实 Unison 集成测试** | 32（含 5 个"已知缺陷"断言） | 27 通过 + 5 expected-fail |
| **新增：主进程 IPC 测试** | 29 | 全部通过 |
| **新增：Electron 端到端（CDP 驱动真实 UI）** | 24 项断言 | 23 通过 + 1 项夹具自误判 |
| 类型检查 `tsc --noEmit` | — | 通过 |
| 生产构建 + electron-builder 打包 | — | 通过 |

**合计：155 个自动化用例（150 通过 + 5 expected-fail）**，另有真实应用端到端验证。
本次**未修改任何产品代码**，仅新增测试与测试配置。

发现 **5 个需要产品层面决策的真实问题**（见第四节），其中 3 个涉及数据安全。

---

## 二、新增测试资产

### 2.1 `tests/main/libs/sync-manager.integration.test.ts` — 真实引擎集成测试

与既有 `sync-manager.test.ts`（mock 掉 `child_process`）互补：**不 mock 进程**，直接调用仓库内置
Unison 二进制，断言"参数组合 → 磁盘真实结果"。二进制缺失时整组 `skipIf` 跳过，
因此 Linux CI（不下载二进制）不会失败。

覆盖：首次同步 / 双向收敛 / `-prefer newer` / 删除传播 / 冲突识别与定向解决 / 冲突作用域 /
单向镜像 / 单向幂等（`-times`）/ 忽略规则（默认 + 任务级 + `.wizsync`）/ 备份（覆盖与删除）/
`-path` 局部同步 / Unicode NFC 归一化 / 中日韩文件名 / 大小写折叠 / 磁盘离线与恢复 /
同步中停止 / 多线程 300 文件 / 9MB 大文件 / 空目录 / 归档重建。

### 2.2 `tests/main/ipc/ipc-handlers.test.ts` — 主进程 IPC 测试

`main.ts`（994 行）此前**零覆盖**。用 mock 的 electron 捕获全部 `ipcMain.handle` 后逐个调用：

- 任务保存：备份目录补全、目录统计、跨任务重叠/嵌套拒绝、编辑自身放行
- **路径穿越防护**：`delete-file` / `delete-files` / `reveal-in-explorer` / `sync-single-file`
  对 `../` 越界一律拒绝；批量操作任一越界整体拒绝
- 备份：保留期过滤、越界删除拒绝、移入废纸篓而非永久删除、`open-backup-folder` 自动建目录
- 忽略规则：单条幂等、批量去重、内置黑名单
- 目录对比：四类结果分类、同步中拒绝、`cancel-compare` 取消语义
- 批量同步：越界整体拒绝、全量协调后返回新差异、空列表短路

### 2.3 `vitest.config.ts`

`testTimeout` / `hookTimeout` 提到 30s——集成测试会真实派生 Unison 进程（单次约 1s），
默认 5s 不够。

### 2.4 端到端（未入库，脚本在 `/tmp/wizsync-e2e/`）

通过 `--remote-debugging-port` + CDP 直接驱动**真实 Electron 应用**，覆盖：

- 任务 CRUD、路径冲突提示、目录统计与磁盘容量显示
- 手动同步 / 定时同步 / 单向镜像 / 冲突检测 → 卡片 warning → 对比页"两边都改过"区块 → 点击"使用源端版本"解决
- 对比差异四区块、单文件同步、批量同步、忽略/取消忽略
- 备份弹窗、日志弹窗（实时推送）、设置弹窗、托盘资源
- 定时任务磁盘离线 → `error` + 日志 → 重连后自动恢复同步
- 生产构建（`file://`）与 electron-builder 打包产物（CSP 生效、`app.asar.unpacked` 内置二进制、单实例锁）

> E2E 全程使用 `--user-data-dir` 隔离目录，**未触碰**你本机真实数据
> （`~/Library/Application Support/wizsync` 仍只有原任务 `test`）。

---

## 三、验证通过的关键行为

- 双向同步、单向镜像、删除传播、大文件/大量小文件、空目录均正确
- 冲突：Unison 判定 → `warning` 状态 + `conflicts` 上报 → 对比页展示 → 定向解决后清空，作用域正确（局部解决不误清其他冲突）
- 名片/日语/韩文文件名、NFD→NFC 归一化后再次同步"无变动"
- 备份：覆盖与删除都产生备份，备份目录不回灌源端
- 磁盘离线 → `error` 并挂起；重连后定时任务自动恢复
- 路径穿越防护全部生效；删除一律走废纸篓
- 打包产物：CSP 生效（内联脚本被阻止）、使用 `app.asar.unpacked` 内的 Unison、版本号正确、单实例锁生效
- 应用内退出（设置页"退出应用"）在同步进行中也能 1 秒内退出、无 Unison 残留

---

## 四、发现的问题（按严重程度）

### 🔴 P1-1 目标端整体变空时，双向同步会**清空源端**

**场景**：SD 卡/移动硬盘被拔插后以**存在但为空**的挂载点重新出现（卷被重新格式化、挂载点复用），
或在系统里目录被误清空，随后的双向同步会把源端所有文件删除。

**根因**：`sync-manager.ts` 固定传 `-confirmbigdel=false`，关掉了 Unison 自带的
"某个副本根目录被完全清空"保护。

实测：目标端 3 个文件被清空 → 同步删除源端全部 3 个文件（备份目录有副本，但源端已空）。
即使 `-backup` 开启，用户看到的是"文件全没了"。

附带发现：`handleOffline` 只在路径**不存在**时触发；目录存在但为空不会被判离线。

**建议**：去掉 `-confirmbigdel=false`，或改为在检测到"一侧根目录文件数为 0 且归档中记录非空"时
中止同步并提示用户。这是一处一行参数改动，但会改变"大批量删除自动确认"的既有行为，需产品确认。

### 🔴 P1-2 单向镜像会留下 `xxx (conflict_on_YYYY-MM-DD).txt` 副本，且**每次同步继续叠加**

**场景**：单向（源→目标 / 目标→源）模式下，权威端不存在的文件不会被删除，而是被加上
`(conflict_on_...)` 后缀留在原地；下一次同步又对副本再复制一次，文件名不断变长。

实测单个文件连续 3 次同步后：
```
only-target (conflict_on_2026-11-03) (conflict_on_2026-11-03) (conflict_on_2026-11-03).txt
```

**根因**：全局固定传 `-copyonconflict`，与 `-force`（单向镜像）组合时 Unison 的行为是
"保留被覆盖方副本"。A/B 实测：去掉 `-copyonconflict` 后镜像删除行为完全正确。

**影响**：README / 新建任务弹窗承诺"目标端多余文件会被自动删除"，实际不删除；
对比页的"全部同步到目标端"按钮也会因此残留文件（实测触发）。

**建议**：`-copyonconflict` 仅在双向模式下传；单向镜像模式去掉它。

### 🟠 P2-1 打包应用收到 SIGTERM 时退出卡死

**场景**：打包后的 `.app`（以及开发模式）收到 `SIGTERM`（系统关机、`kill`、某些守护进程管理）
后卡在"正在执行退出前清理..."，进程不退出。

**定位**：主进程退出流程 `before-quit` → `preventDefault()` → 异步清理 → `app.quit()`。
埋点显示清理已全部完成、`app.quit()` 已返回，但进程常驻。改为 `app.exit(0)` 后
**2 秒内正常退出**（开发模式与打包产物均验证）。

用户从界面"退出应用"或 Cmd+Q 不受影响（1 秒内退出）。

**建议**：清理完成后用 `app.exit(0)` 取代第二次 `app.quit()`。

### 🟠 P2-2 备份文件沿用旧版本 mtime，会在下次启动被"保留期清理"误删

`-times` 让备份文件继承被覆盖版本的 mtime。清理逻辑按 mtime 判断 30 天保留期，
于是"今天刚备份的一个 60 天前修改过的文件"会被立即删除。

实测：源端 60 天前修改的文件今天被覆盖 → 备份文件 mtime 也是 60 天前 → 下次启动即失效。

**建议**：备份后把备份文件 mtime 更新为当前时间，或清理逻辑改用 ctime / 单独的记录文件。

### 🟠 P2-3 fastcheck 漏检「同一秒内、等长」的修改，且不会自愈

`-fastcheck=true` 以"大小 + 整秒 mtime"判定变更。在同一秒内把文件改成**等长**的新内容，
Unison 报 `Nothing to do`，后续同步也永远不修复（归档已记录该状态）。

实测：`AAAAAAAAAA\n` → 同一秒改为 `BBBBBBBBBB\n` → 目标端永远停留在 `AAAAAAAAAA`。

**建议**：属 Unison fastcheck 固有限制。可在文档中说明；或对"最近 2 秒内修改过"的文件
在任务级用 `-fastcheck=false` 兜底（代价是全量哈希）。

### 🟡 P3-1 其他观察

- 备份目录固定在 `<目标目录>/.wizsync/backups`，**UI 无法修改**（`TaskModal` 没有该字段，
  `onSelectDir("backupPath")` 未被调用），与 README"支持设置"略有出入。
- 对比弹窗的区块级"全部同步到 X 端"会执行**整树镜像**（`sync-files` 传 `undefined` 路径，
  以所选端为权威协调整棵树），而不是只处理该区块列出的文件。实测：在"仅在源目录"区块点
  "全部同步到目标端"，目标端独有的文件也被处理（叠加 P1-2 留下副本）。
- 日志按天写入 `<目标目录>/.wizsync/logs`；目标目录不可写时回退到全局目录，逻辑正确。

---

## 五、未覆盖 / 受限项

- **无真实 SD 卡**：磁盘离线用"重命名目标目录"模拟；低磁盘警告色（<1GB / <200MB）未做真机验证。
- **托盘菜单**：资源与创建流程已验证，但 macOS 托盘点击弹出菜单需要辅助功能权限，未做点击级断言。
- **Windows / Linux**：本机为 macOS arm64，仅验证 darwin 二进制；CI 的 Linux job 不下载二进制，
  集成测试会整组跳过（符合预期）。
- **Finder 定位 / 废纸篓**：`shell.showItemInFolder` / `trashItem` 在 IPC 测试中以 mock 断言参数，
  未做跨进程真实弹窗验证。

---

## 六、复现方式

```bash
pnpm test          # 全部 155 个用例（macOS 下含真实 Unison 集成测试）
pnpm exec tsc --noEmit
```

"已知缺陷"用例使用 `it.fails` 固化：修复后 Vitest 会报
`expected test to fail but it passed`，届时把 `it.fails` 改回 `it` 即为回归测试。

---

## 七、修复记录（2026-11-03）

测试报告中 5 个问题均已修复，并转为正式回归用例。

### 修复 1（原 P1-1）整体清空保护

**改动**：`src/main/libs/sync-manager.ts`

新增两道判断，在双向全量同步前检查两侧根目录：

- `hasSyncableEntries()`：按与 unison 一致的忽略口径（跳过隐藏项、`node_modules`、
  `Thumbs.db`、`desktop.ini`）判断目录是否"有内容"
- `hasUnisonArchive()`：读取任务元数据目录中的 `ar*` / `fp*`，确认这对目录此前同步过

若**已有归档**且恰好一侧为空、另一侧有文件，则中止同步并置 `error`，日志给出可操作提示。
不做拦截的情形：

- 首次同步（无归档）：一侧为空是正常的首次复制
- 单向镜像（`-force`）：清空一侧是用户明确表达的意图
- `-path` 局部同步：只作用于指定路径，不会被误伤

需要真正清空时，仍可通过「对比差异」按文件删除（走 `delete-file` 路径），或「强制重置」重建基线。

### 修复 2（原 P1-2）单向镜像不再产生副本

**改动**：`src/main/libs/sync-manager.ts`

`-copyonconflict` 改为**仅双向同步时传入**。此前它与 `-force`（单向镜像、
对比页「使用某端版本」）组合时，unison 会保留被覆盖方副本并逐次叠加。

### 修复 3（原 P2-1）SIGTERM 退出卡死

**改动**：`src/main/main.ts`

`before-quit` 清理完成后由 `app.quit()` 改为 `setImmediate(() => app.exit(0))`。
`app.quit()` 只是再次发出 `before-quit`，实测（开发模式与打包产物）进程会常驻不退出。

### 修复 4（原 P2-2）备份时间戳

**改动**：`src/main/libs/sync-manager.ts`

同步前对备份目录做快照（`snapshotBackupDir`），进程结束后把**本次新增/覆盖**的备份文件
mtime 更新为当前时间（`refreshBackupTimestamps`）。这样保留期只作用于"备份产生时间"，
不会再误删刚备份的旧版本文件。既有备份不受影响。

### 修复 5（原 P2-3 + P3）快速检查开关与备份目录可配置

**改动**：`src/main/libs/types.ts`、`src/main/libs/sync-manager.ts`、`src/main/main.ts`、
`src/main/preload.ts`、`src/render/components/TaskModal.tsx`、`src/render/App.tsx`、
`src/render/types.d.ts`

- 新增任务级 `useFastcheck` 开关（默认开启）。关闭后传 `-fastcheck=false`，
  每次做全量内容哈希，可识别"同一秒内等长修改"这类 fastcheck 漏检的变更
- 任务弹窗新增**备份目录**选择器与「恢复默认」，`get-default-backup-path` 支持传入目标目录
  （新建任务尚未落盘时也能算出正确默认值）
- 保存任务时校验：备份目录**不能位于同步目录内部**（默认的 `<目标>/.wizsync/backups` 除外），
  否则备份文件会被当作待同步内容反向灌到另一端

### 修复后的验证

| 验证层 | 结果 |
|---|---|
| 单元 + 集成测试 | **179 通过 + 1 expected-fail**（原 5 个缺陷用例，4 个转为正式回归用例） |
| `tsc --noEmit` | 通过 |
| 开发模式端到端 | 镜像删除/清空保护/备份时间戳/快速检查/备份目录/UI 开关 全部通过 |
| 打包产物端到端 | CSP、镜像删除、清空保护、SIGTERM 2 秒退出 全部通过 |

仍保留 1 个 `it.fails`：`fastcheck` 默认开启时对「同一秒内等长修改」的漏检是
Unison fastcheck 的固有行为，现在可通过关闭快速检查规避（已为该开关补正向用例）。
