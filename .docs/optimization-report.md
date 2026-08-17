# WizSync 代码审查报告：安全 / 数据隐患 / 性能

> 审查日期：2026-08-17
> 审查范围：`src/main/*`、`src/render/*`、构建配置
> 技术栈：Electron 29 + React 18 + Unison 2.53.8（内置二进制，`spawn` 数组传参，无 shell 注入面）

---

## 摘要

| 类别 | 严重 | 数量 |
|---|---|---|
| 安全漏洞 | 🔴 P1 ×2 / 🟠 P2 ×3 / 🟡 P3 ×3 | 8 |
| 数据隐患 | 🔴 P1 ×1 / 🟠 P2 ×2 / 🟡 P3 ×1 | 4 |
| 性能问题 | 主犯 ×3 / 次要 ×4 | 7 |

**优先建议**：先修 P0/P1 的安全与批量同步问题（改动小、收益大），数据策略类问题建议在产品层面确认后再动。

---

## 一、安全漏洞

### 🔴 P1-1 任意文件删除：`delete-backup-file`

**位置**：`src/main/main.ts:388-398`

```ts
ipcMain.handle("delete-backup-file", (_event, filePath: string) => {
  const stats = fs.statSync(filePath);   // 任意路径
  if (!stats.isFile()) return false;
  fs.unlinkSync(filePath);               // 直接删除
  return true;
});
```

**问题**：渲染进程可传入任意绝对路径，主进程不校验该路径是否位于任务的备份目录内。一旦渲染层被攻破（XSS / 调试工具），等于获得"删除本机任意文件"的能力。

**修复**：按 `taskId` 反查 `task.backupPath`，将 `filePath` resolve 后校验前缀；不在备份目录内一律拒绝。

---

### 🔴 P1-2 路径穿越导致任意文件删除：`delete-file`

**位置**：`src/main/main.ts:400-435`

```ts
const basePath = side === "source" ? task.sourcePath : task.targetPath;
const fullPath = path.join(basePath, filePath);  // filePath 来自渲染进程
...
fs.unlinkSync(fullPath);
```

**问题**：`filePath` 是渲染进程传的相对路径，`path.join` 不拦截 `..`，传 `../../.ssh/authorized_keys` 等即可删除同步根目录之外的文件。UI 正常流程只会传扫描结果里的相对路径，但主进程缺少第二道防线。

**修复**：统一加越界校验——`path.resolve(basePath, filePath)` 后确认以 `basePath + path.sep` 开头，否则返回 false 并记日志。

---

### 🟠 P2-1 同类路径穿越

以下 IPC 同样对 `filePath` 未做越界校验（`path.join(task.sourcePath / task.targetPath, filePath)`）：

| 位置 | 危害 |
|---|---|
| `sync-single-file` `main.ts:275-283` | 可将根目录外任意文件同步进目标目录（数据污染 / 泄露） |
| `reveal-in-explorer` `main.ts:317` | 任意路径 reveal |
| `reveal-backup-file` `main.ts:328` | 任意路径 reveal（无归属校验） |

**修复**：与 P1-2 共用同一个 `assertWithinRoot(base, filePath)` 工具函数；`reveal-backup-file` 改为按 taskId 校验。

---

### 🟡 P3-1 缺少 CSP + 未显式声明 webPreferences 安全项

- `index.html` 无 CSP meta 标签。
- `BrowserWindow`（`main.ts:80-83`）只设置了 `preload`。

**现状**：Electron 29 默认 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，当前是安全的；且应用不加载远程内容、无 `openExternal`、无网络请求。风险低，但建议显式声明防回归：

```ts
webPreferences: {
  preload: path.join(__dirname, "preload.mjs"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
}
```

并加 CSP：
```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'" />
```

---

### 🟡 P3-2 PID 复用误杀

**位置**：`src/main/libs/sync-manager.ts:186-189`

```ts
const storedTask = syncStore.getTasks().find(t => t.id === id);
if (storedTask?.pid) {
  try { process.kill(storedTask.pid); } catch {}
```

**问题**：从持久化存储回读 PID 后 `process.kill`（默认 SIGTERM），若 PID 已被系统复用，短窗口内可能误杀无关进程。

**修复**：优先使用 `activeProcesses` Map 中的 `ChildProcess` 对象；`stopAllTasks` 同理。

---

### 🟡 P3-3 仓库杂物

- Git 已跟踪 `src/main/main.ts.orig`、`src/render/components/TaskModal.tsx.orig`、`public/.DS_Store`。
- 建议删除并加入 `.gitignore`。

---

## 二、数据隐患

### 🔴 P1-3 单向同步 `-force` 静默删除目标端文件，且 `-confirmbigdel=false`

**位置**：`src/main/libs/sync-manager.ts:339-352, 333`

```ts
if (currentDirection === "sourceToTarget") {
  args.push("-prefer", task.sourcePath);
  args.push("-force", task.sourcePath);   // 强制镜像源端
  args.push("-times=false");
}
...
"-confirmbigdel=false", // 自动确认大批量删除
```

**问题**：
- 单向 = 镜像。目标端所有源端不存在的文件会被**静默删除**，不弹确认。
- `-confirmbigdel=false` 取消了 Unison 对大批量删除的二次确认。
- Unison 的 `-backup` 主要覆盖"被覆盖/被修改"的文件，**删除场景不一定有备份**，需实测确认。
- 一旦用户把源/目标配反，就是整盘数据消失。

**建议**：
- 单向任务 UI 明示"单向 = 镜像，目标端多余文件会被删除"。✅ 已实施（TaskModal 方向选择下方出现 ⚠️ 横幅）。
- 去掉 `-confirmbigdel=false`（或仅在手动模式使用）。❌ 保留，理由见下。
- 测试 `-backup` 在删除场景下是否留档。✅ 已实测，**删除会被留档**，结论见 §五。

> **实测结论（2026-08-17，真实 unison 2.53.8 二进制）**：使用 WizSync 完全一致的参数（`-backup Name *` + `-backuplocation central` + `-backupdir` + `-backupprefix bak.$VERSION.`）——
> 1. **修改留档**：覆盖目标文件时，旧内容备份为 `bak/<relpath>`（最新）与 `bak.N.<relpath>`（更旧版本）。
> 2. **删除留档**：从源端删除文件后再次同步，目标端被删文件在删除前的内容完整保留到备份目录（`bak/<relpath>` 内含删除前内容）。
> 因此**删除场景已有备份兜底，无需再启用 `-backupcurr`**；`-confirmbigdel=false` 保留——删除已被备份覆盖 + UI 已警告，若移除它会导致 `-batch` 模式下大批量删除时 Unison 挂起等待确认。
> 附带发现（非本次修复范围）：`-fastcheck=true` 有 1 秒 mtime 分辨率限制，同一秒内两次修改且 size 相同的文件可能被漏检，属 Unison 固有行为。

---

### 🟠 P2-2 手动删除为永久删除 + 备份 30 天自动清理

**位置**：`main.ts:388-398`（删除备份）、`main.ts:400-435`（删除文件）、`main.ts:145-163`（30 天清理）

- 所有删除均为 `fs.unlinkSync` 直删，无回收站 / 无 undo。
- 启动时 `cleanOldBackups` 递归删除备份目录内 30 天前的文件，用户想长期留档的备份会被静默清理。

**建议**：
- 删除改为移入系统废纸篓（`shell.trashItem`），或保留"删除历史"。
- 备份保留期改为任务可配置，并默认更长。

---

### 🟠 P2-3 备份文件存放在被同步的目标目录内部

**位置**：`main.ts:197-199`

```ts
if (!task.backupPath && task.targetPath) {
  task.backupPath = path.join(task.targetPath, ".wizsync", "backups");
}
```

**问题**：
- `.wizsync` 已被 `-ignore Path .wizsync` 排除不会参与同步，但备份与目标数据在同一块物理盘上——目标盘（常为外置盘）损坏时备份一并丢失，"备份"只防误改、不防盘坏。
- 两个任务共享同一目标目录时，`.wizsync` 的日志/备份命名空间互相污染（日志同理，见 `logs.ts:31-39`）。

**建议**：默认备份路径改为独立位置（如 `app.getPath("userData")` 下），或至少在 UI 上提示此风险；共享目录时按 taskId 隔离。

---

### 🟡 P3-4 双向与单向时间戳策略不一致

双向 `-times`（`:351`），单向 `-times=false`（`:343、:347`）。单向同步后目标端 mtime 变为"现在"，与源端不一致 → 下次 `-fastcheck`（size+mtime）判定"内容不同"→ 反复重拷。既是数据一致性问题，也是性能问题（见 §3 主犯 3）。

---

## 三、为什么慢（性能）

### 🔴 主犯 1 — DiffModal 批量操作逐个启动 Unison 进程

**位置**：`src/render/components/DiffModal.tsx:114-150`

```ts
const handleSyncAll = async (files, direction, sectionKey) => {
  for (const file of files) {                       // 串行
    const success = await window.electronAPI.syncSingleFile(taskId, file.path, direction);  // 每个文件 spawn 一次 Unison
  }
};
```

`handleDeleteAll` / `handleIgnoreAll` 同理。

**问题**：每个文件都 `spawn` 一次全新 Unison（冷启动 + 全量扫描各 0.5~2s）。1000 个文件差异 = 1000 次进程启动 = **几十分钟到几小时**。这是"慢"最可能的来源。

**修复**：主进程新增批量 IPC，一次 `runUnison` 把所有相对路径以 `-path` 传入（`runSpecificPathSync` 已支持 `specificPaths: string[]`）。渲染端改为收集路径数组后单次调用。

---

### 🔴 主犯 2 — 同步结束 + 保存任务时全量递归统计，主进程卡顿 + EMFILE

**位置**：`sync-manager.ts:543-556`（`hasChanges` 时 `getDirStats` 双目录）、`main.ts:196-205`（save-task 时）、`src/main/libs/fs-utils.ts:24-49`

```ts
await Promise.all(files.map(async (file) => {       // 大目录一次性上万并发 stat
  ...
  const subStats = await getDirStats(fullPath);     // 递归仍在主进程事件循环
  size += subStats.size;
  count += subStats.count;
}));
```

**问题**：
- 对一个大目录 `Promise.all` 出上万并发 `fs.stat`，macOS 默认软限制 256 fd → **EMFILE**，异常被外层 catch 吞掉，结果静默变成 `{0,0}`。
- 递归全部跑在主进程事件循环上，大目录（几万文件）时 UI 与同步调度一起冻住。
- 每次有变动的同步结束都会触发，外置盘/网络盘上尤其慢。

**修复**：
- 加并发限制（如一次最多 64 个 stat 的信号量）。
- 移出主进程（worker 线程）或改为按需 + 缓存。
- EMFILE/异常时记录错误而不是静默返回 `{0,0}`。

---

### 🔴 主犯 3 — 单向任务 `-times=false` 导致"永远同步不完"

**位置**：`sync-manager.ts:339-352` + `-fastcheck=true`（`:322`）

**原因**：单向同步后目标端 mtime 变为当前时间，源端不变 → 下次 `-fastcheck` 判定不一致 → 每次周期重新复制已同步文件。单向任务表现为"永远在同步、永远同步不完"，且浪费大量 IO。

**修复**（二选一）：
- 单向模式改 `-times=true`（让时间戳传播，契合 `fastcheck`）；
- 或单向模式 `-fastcheck=false`（每次走内容 hash 比对，比反复重拷便宜）。

> 注：另有冗余点——单向模式的 `-force` 参数在 `:341` 与 `:387-388` 重复 push 两次，虽无害但应清理。

---

### 🟠 次要 — 其他慢点

**1. 对比（compare）串行递归 + Map 合并**
- `getAllFiles`（`fs-utils.ts:55-92`）用 `for...of` 串行递归子目录，与 `getDirStats` 的并发写法不一致，深目录慢。
- 每个子目录结果用 `subFiles.forEach(... result.set(...))` 逐项合并，大目录下有一定开销。
- 建议与 `getDirStats` 一致改用并发 + 限制，或直接收集全量列表后一次 build Map。

**2. 单文件操作触发全量扫描**
- `delete-file` / `ignore-path` 完成后 `requestIncrementalSync`（`sync-manager.ts:39-55`）→ `startTask` → 不带 `specificPaths` 的**全量** Unison 扫描。
- 在几十万文件的目录里删一个文件 = 全量扫一遍。建议手动操作后也走 `-path` 增量。

**3. 日志同步写主进程**
- `logs.ts:68` 每行 `fs.appendFileSync`，同步期间 Unison 输出多时会阻塞主线程。可批量缓冲或异步写。

**4. electron-store 全量重写**
- `sync-store.ts:53` 每次 `updateTask` 全文件 JSON 写盘，同步期间状态/pid 频繁更新有写盘放大。属低频开销，优先级最低。

**5. compare 无取消机制**
- 大目录对比一旦发起无法中断，UI 无取消按钮。建议加 AbortController。

---

## 四、修复优先级清单

| 优先级 | 改动 | 收益 | 涉及文件 |
|---|---|---|---|
| P0 | 删除/同步/揭示类 IPC 统一加路径越界校验 | 堵住任意删除与穿越 | `main.ts` |
| P0 | DiffModal 批量操作改单次 Unison 多 `-path` | 批量速度提升 100~1000× | `main.ts`、`DiffModal.tsx` |
| P1 | 单向同步 `-times=true`（或 `fastcheck=false`） | 消除"永远同步不完" | `sync-manager.ts` |
| P1 | `getDirStats` 并发限制 + 移出主进程 + 错误不静默 | 消除大目录卡顿/EMFILE | `fs-utils.ts`、`sync-manager.ts` |
| P1 | 单向 `-force` 删除提示 + `confirmbigdel` 保留 + 备份删除场景实测 | 防数据消失 | `sync-manager.ts`、`TaskModal.tsx` |
| P2 | CSP + 显式 webPreferences 安全项 | 纵深防御 | `index.html`、`main.ts` |
| P2 | 手动单文件操作后走 `-path` 增量 | 大目录响应快 | `sync-manager.ts` |
| P2 | 删除改废纸篓 + 备份保留期可配置 | 可撤销、防误清 | `main.ts`、`TaskModal.tsx` |
| P3 | PID 处理改用 ChildProcess 对象 | 防误杀 | `sync-manager.ts` |
| P3 | 清理 `.orig` / `.DS_Store` | 仓库整洁 | 仓库 |
| P3 | compare 支持取消 | 交互体验 | `main.ts`、`DiffModal.tsx` |

---

## 五、实施进度

### ✅ 已完成（2026-08-17）

**P0-1 路径越界校验**（堵住任意删除 / 穿越）
- 新增 `isPathInside` / `resolveInside`（`src/main/libs/fs-utils.ts`），主进程新增 `resolveInRoot` / `resolvePathsInRoot` 辅助函数。
- `delete-file`、`sync-single-file`、`reveal-in-explorer`：相对路径经 `resolveInRoot` 校验，越界拒绝并记日志。
- `delete-backup-file`、`reveal-backup-file`：签名改为 `(taskId, filePath)`，只允许操作该任务备份目录内的路径。
- 同步更新 `preload.ts`、`types.d.ts`、`BackupModal.tsx` 调用方。

**P0-2 批量操作单次 Unison 多 `-path`**
- 新增批量 IPC：`sync-files` / `delete-files` / `ignore-paths`（`main.ts`），`DiffModal` 的"全部同步 / 全部删除 / 全部忽略"改走批量接口。
- `runSpecificPathSync` 改为接收 `string[]`；`sync-files` 每批 400 个 `-path`，逐批 `await`，避免 exec 参数超限（ARG_MAX）。
- `runUnison` 重构为返回在进程结束时才 resolve 的 `Promise<void>`，使批量分块能真正串行等待完成（spawn 前各早退分支同步返回，error/close 各退出点均 resolve）。

> 验证：`npx tsc --noEmit` 通过；`npx vite build` 三端（renderer/main/preload）构建通过。

**P1 单向同步传播时间戳**（消除"永远同步不完"）
- `src/main/libs/sync-manager.ts`：单向（sourceToTarget / targetToSource）的 `-times=false` 改为 `-times`，让目标端 mtime 与源端一致，`-fastcheck`（size+mtime）能判定一致从而跳过，避免每次同步全量哈希比对。
- 顺带移除了方向块末尾重复的 `-force` 参数。
- ⚠️ 注意：启用后首次同步会重新校验所有已同步文件并补齐 mtime（内容相同仅更新时间戳，不重拷数据），之后即恢复正常速度。

**P1 getDirStats 并发限制 + 错误不静默**
- `src/main/libs/fs-utils.ts`：新增 `Semaphore` 信号量 + `STAT_CONCURRENCY=64`；`getDirStats` 整棵遍历共享同一个信号量，`readdir`/`stat` 均限流，杜绝大目录上万并发 stat 导致的 EMFILE。
- 单个文件统计失败只跳过该文件并记日志，不再让整棵树静默归零为 `{0,0}`。
- 验证：真实目录树对比串行扫描结果一致，最大并发严格控制在限制值内；`tsc` + `vite build` 通过。
- 未做：移出主进程（worker 线程），仍运行在主进程事件循环，但对小目录影响可忽略。

**P1 单向删除提示 + 备份删除场景实测**
- `TaskModal.tsx`：方向选择为单向（sourceToTarget / targetToSource）时，下方出现 ⚠️ 横幅明示"单向 = 镜像，目标端多余文件会被删除，且无二次确认"。
- `-confirmbigdel=false` 保留（删除已有备份兜底，见 §二 P1-3 实测结论）。
- 备份删除场景实测通过：Unison `-backup` 对**删除**同样留档，无需 `-backupcurr`。

**P2 CSP + 显式 webPreferences 安全项**
- `main.ts`：`webPreferences` 显式声明 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`。
- 打包环境下经 `session.defaultSession.webRequest.onHeadersReceived` 注入 CSP（`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`），开发模式不受影响（Vite HMR 需要）。

**P2 手动单文件操作后走 `-path` 增量**
- `sync-manager.ts`：`requestIncrementalSync(id, paths?)` 新增可选路径参数；提供路径时按每批 400 个 `-path` 分块串行执行 `runSpecificPathSync`，否则回退全量 `startTask`。
- `delete-file` / `delete-files` 完成后改为只对删除的路径做增量同步，大目录下不再全量扫描。

**P2 删除改废纸篓 + 备份保留期可配置**
- `delete-file` / `delete-files` / `delete-backup-file` 全部由 `fs.unlinkSync` 改为 `await shell.trashItem(...)`，删除可恢复（系统废纸篓）。
- `SyncTask` 新增 `backupRetentionDays?: number`（`main/libs/types.ts`、`render/types.d.ts`）；`TaskModal` 新增"备份保留天数"输入框；启动清理与 `list-backup-files` 过滤均改用 `getRetentionMs(task)`，未配置时默认 30 天。

**P3 PID 处理改用 ChildProcess 对象**
- `stopTask`：只通过 `activeProcesses` Map 中的句柄 kill，移除回读持久化 pid 的 `process.kill`（陈旧 PID 可能被系统复用导致误杀）。
- `stopAllTasks`：改为对活跃句柄 SIGTERM → 500ms 后对仍存活句柄 SIGKILL；存储中的 pid 仅用于清除记录，不再参与 kill。

**P3 compare 支持取消**
- `fs-utils.ts`：`getAllFiles` 新增 `signal?: AbortSignal`，abort 后立即抛出 `AbortError`。
- `main.ts`：`compare-directories` 创建 `AbortController`，扫描与合并阶段均检查信号；新增 `cancel-compare` IPC。
- `preload.ts` / `types.d.ts`：暴露 `cancelCompare`；`DiffModal` 扫描态新增"取消对比"按钮（取消后关闭弹窗）。

**P3 清理仓库杂物**
- `git rm` 移除 `src/main/main.ts.orig`、`src/render/components/TaskModal.tsx.orig`、`public/.DS_Store`；`.gitignore` 增加 `*.orig`；根目录及忽略目录下的 `.DS_Store` 均已被忽略、无已跟踪残留。

> 全量验证：`npm install` 后 `tsc --noEmit` 与 `vite build` 通过（见下方执行记录）。

---

## 六、已验证的安全基线（当前做得好的部分）

- `spawn(unisonPath, args, ...)` 数组传参，**无 shell 拼接**，`task.name` / `ignoredPaths` 不会造成命令行注入。
- 无 `eval`、无 `exec`、无远程内容加载、无网络请求、无 `openExternal`。
- 无硬编码密钥/Token。
- 启动同步前用 `realpathSync` 校验源/目标不为同一真实路径、无嵌套关系，杜绝自同步与递归建目录。
- `.wizsync` 已被忽略，不会回灌同步。
