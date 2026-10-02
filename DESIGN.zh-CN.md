# zen-fs-remotestoragejs — 设计文档

## 概述

本文档描述将新增到 `RemoteStorageFileSystem` 的两个特性：

1. **快照（Snapshot）** —— 用于高效实现 `shouldSync()` 的内存 ETag 基线
2. **精确 mtime** —— 通过 sidecar（边车）文件在同步过程中保留毫秒级精度的 mtime

这两个特性完全自包含在 `zen-fs-remotestoragejs` 内部，无需修改 `zen-fs-core`、`zen-fs-sync` 或 `zen-fs-config`。

---

## 1. 快照（ETag 基线）

### 1.1 问题

`zen-fs-sync` 的 `SyncableFS` 接口定义了一个可选方法：

```typescript
shouldSync?(): Promise<boolean>;
```

> 将后端保存的基线状态与实际远端状态进行比较。
> 如果远端存在需要同步的外部变更，返回 `true`。
> 后端应在每次调用后更新其内部基线。
> 首次调用（尚无基线）应初始化基线并返回 `true`。

`RemoteStorageFileSystem` 当前**没有实现 `shouldSync()`**。因此 `zen-fs-sync` 会退化为周期性的全量扫描——它遍历两端的整棵文件树，比较每个文件的 `size` 与 `mtimeMs` 来检测变更。对于含大量文件的后端，这种开销很大。

### 1.2 RemoteStorage 协议的优势

RemoteStorage 协议（draft-dejong-remotestorage-27）通过 ETag 提供了内建的版本控制：

- 每个文档和文件夹都有强 ETag
- 文档更新会将其 ETag 变更传播到所有祖先文件夹
- 对根文件夹的一次 GET 请求即可返回一个包含全部条目 ETag 的 JSON-LD 列表

这意味着：**对根文件夹的一次 GET 就足以知道是否有任何变更**。如果根文件夹的 ETag 没变，整棵树里没有任何文件被修改。

### 1.3 设计

快照是由 `RemoteStorageFileSystem` 维护的一份**内存 `Map<path, etag>`**。它不会持久化到 RemoteStorage——每次程序重启都会从头重建。

```
RemoteStorageFileSystem
  ├─ snapshot: Map<string, string> | null    ← path → ETag（内存中）
  ├─ rootEtag: string | null                 ← 根文件夹的 ETag
  │
  └─ shouldSync(): Promise<boolean>
       │
       ├─ snapshot === null?
       │   ├─ 是 → buildSnapshot() → 返回 true（首次调用，需要全量同步）
       │   └─ 否  → 继续
       │
       ├─ HEAD 根文件夹 → 获取当前 rootEtag（1 次 HTTP 请求）
       │
       ├─ currentRootEtag === this.rootEtag?
       │   ├─ 是 → 返回 false（无变更）
       │   └─ 否  → buildSnapshot() → 返回 true（有变更）
       │
       └─ (snapshot 作为 buildSnapshot 的副作用被更新)
```

### 1.4 buildSnapshot()

```
buildSnapshot()
  │
  ├─ GET /（根文件夹列表，JSON-LD）
  │   响应包含根 ETag + 所有顶层条目的 ETag
  │
  ├─ this.rootEtag = response.etag
  ├─ this.snapshot = new Map()
  │
  └─ 对列表中的每一项：
       ├─ 若为文档（无结尾 '/'）：
       │   snapshot.set(itemPath, itemETag)
       │
       └─ 若为文件夹（结尾 '/'）：
           └─ 递归 GET 该文件夹，重复上述过程
              （文件夹 ETag 也会被存储，用于子树级别的比较）
```

### 1.5 优化：子树剪枝

当 `shouldSync()` 检测到根 ETag 变化时，它不需要重建整个快照。它可以逐层遍历树，比较文件夹 ETag：

```
根 ETag 变化了？
  └─ GET 根列表
     └─ 对每个子文件夹：
        ├─ 子文件夹 ETag 未变？ → 跳过该子树（内部无变更）
        └─ 子文件夹 ETag 变了？ → GET 该文件夹，递归
```

这能将 HTTP 请求降到最低：只拉取发生变更的子树。

### 1.6 生命周期

```
程序启动
  └─ snapshot = null（内存中，不持久化）

首次 shouldSync() 调用
  └─ snapshot 为 null → buildSnapshot() → 返回 true
     zen-fs-sync 执行一次全量同步

后续 shouldSync() 调用（每个 pollIntervalMs，默认 30 分钟）
  └─ HEAD 根（1 次请求）
     ├─ rootEtag 未变 → 返回 false（0 次额外请求）
     └─ rootEtag 变了 → 为变更的子树重建快照 → 返回 true

程序重启
  └─ snapshot = null → 下一次 shouldSync() 重建并返回 true
     zen-fs-sync 的 syncBidirectional 会比较实际文件内容，
     发现无变更并跳过。无数据丢失，仅多了一次扫描。
```

### 1.7 为什么不把快照持久化到 RemoteStorage？

1. **不需要**：只有 `RemoteStorageFileSystem` 使用它，无需跨设备共享
2. **避免反馈回路**：把快照文件写入 RS 会改变根 ETag，导致下一次 `shouldSync()` 检测到"变更"
3. **简单**：纯内存状态——没有一致性、崩溃恢复或 sidecar 管理的问题

### 1.8 API

无新增公开 API。`shouldSync()` 本就是 `zen-fs-sync` 中 `SyncableFS` 接口的一部分。在 `RemoteStorageFileSystem` 上实现它对调用方完全透明：

```typescript
class RemoteStorageFileSystem extends FileSystem {
  // ... 已有方法 ...

  // 新增：为 zen-fs-sync 实现 shouldSync
  async shouldSync(): Promise<boolean> {
    if (this.snapshot === null) {
      await this.buildSnapshot();
      return true;
    }

    const currentRootEtag = await this.fetchRootEtag();
    if (currentRootEtag === this.rootEtag) {
      return false;
    }

    await this.buildSnapshot();  // 重建基线
    return true;
  }

  // 新增：本地写入后更新快照（由 writeFile/unlink 内部调用）
  private updateSnapshotForPath(path: string, etag: string | null): void {
    if (this.snapshot === null) return;
    if (etag === null) {
      this.snapshot.delete(path);
    } else {
      this.snapshot.set(path, etag);
    }
    // 因为我们刚修改了文件，将 rootEtag 标记为失效
    this.rootEtag = null;
  }
}
```

### 1.9 本地变更处理

当本地调用 `writeFile()` 或 `unlink()` 时，应更新快照以反映该变更，这样下一次 `shouldSync()` 就不会把本地写入误报为"远端变更"：

```
writeFile(path, data)
  ├─ PUT 到 RemoteStorage
  ├─ 响应包含新 ETag
  └─ updateSnapshotForPath(path, responseEtag)
     ├─ snapshot.set(path, newEtag)
     └─ rootEtag = null（已失效，下次 shouldSync 会刷新）

unlink(path)
  ├─ 对 RemoteStorage 发起 DELETE
  └─ updateSnapshotForPath(path, null)
     ├─ snapshot.delete(path)
     └─ rootEtag = null
```

---

## 2. 精确 mtime

### 2.1 问题

RemoteStorage 协议根据 PUT 请求到达服务器的时间设置 `Last-Modified`——客户端无法控制它。这带来两个问题：

1. **不精确**：服务器的 `Last-Modified` 被取整到秒；原始 mtime 可能具有毫秒精度
2. **同步时被覆盖**：当文件 A（mtime: 1700000000123）被同步到 RemoteStorage 时，服务器将 `Last-Modified` 设为 PUT 时间（如 1700000005000）。原始 mtime 丢失

`zen-fs-sync` 在 `FileSnapshot` 中使用 `mtimeMs` 进行变更检测：
```typescript
interface FileSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
}
```

如果 mtime 被服务器覆盖，同步引擎会在每次同步时都看到一个"被修改"的文件，导致不必要的拷贝。

### 2.2 RemoteStorage 协议的局限

RS 协议（draft-dejong-remotestorage-27）不支持：
- PUT 上的自定义 HTTP 头（只保存 `Content-Type`）
- 客户端指定的 `Last-Modified`
- 除 ETag、Content-Type、Content-Length、Last-Modified 之外的逐文档元数据

因此，精确 mtime 必须通过**应用层的 sidecar 文件**来保留。

### 2.3 设计：`.mtime` 边车文件

对于路径 `/foo/bar.json` 的每个文件，一个名为 `/foo/.bar.json.mtime` 的 sidecar 文件保存精确 mtime：

```
/foo/bar.json           ← 文件内容
/foo/.bar.json.mtime    ← { "mtime": 1700000000123 }
```

**命名约定**：侧车是数据文件名加上 `.mtime` 后缀，即 `<name>.mtime`，**不要**在前面加点。这样对所有文件名（包括 dotfile）都能通过其他后端的反向映射正确还原。

```typescript
function mtimePathFor(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? filePath.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  const mtimeFileName = `${fileName}.mtime`;
  return dir ? `${dir}/${mtimeFileName}` : mtimeFileName;
}
```

### 2.4 Sidecar 内容

```json
{
  "mtime": 1700000000123
}
```

极小且故意保持简单。仅含 `mtime`（自纪元起的毫秒数）。

### 2.5 集成点

#### writeFile

```typescript
async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: {
  flag?: string;
  mtime?: number;    // 新增：可选的精确 mtime
}): Promise<void>
```

```
writeFile(path, data, options)
  │
  ├─ PUT 文件内容到 RemoteStorage
  │
  ├─ 若启用了 preciseMtime：
  │   ├─ mtime = options.mtime ?? Date.now()
  │   └─ PUT .mtime sidecar：{ "mtime": mtime }
  │
  └─ 更新存在性缓存
```

如果未提供 `options.mtime`，则使用 `Date.now()`。这确保了即便没有显式 mtime，sidecar 也能捕获客户端写入时间（可能不同于服务器的 `Last-Modified`）。

#### writeFileWithMtime

```typescript
async writeFileWithMtime(path: string, data: string | Uint8Array | ArrayBuffer, mtime: number): Promise<void>
```

实现了 `zen-fs-sync` 中可选的 `SyncableFS.writeFileWithMtime` 方法。它委托给 `writeFile(path, data, { mtime })`，后者同时写入文件内容和 `.mtime` sidecar。同步引擎（若可用）会调用此方法而非 `writeFile`，以在同步过程中保留源文件的 mtime。若未实现此方法，同步引擎会退化为普通的 `writeFile`。

#### stat

```
stat(path)
  │
  ├─ HEAD 请求 → 获取服务器 Last-Modified、Content-Length
  │
  ├─ 若启用了 preciseMtime：
  │   ├─ 尝试读取 .mtime sidecar（GET .mtime 文件）
  │   ├─ sidecar 存在？ → 使用 sidecar 的 mtime（精确，毫秒级）
  │   └─ sidecar 缺失？ → 退化为服务器的 Last-Modified（秒级精度）
  │
  └─ 返回带有 mtimeMs 的 InodeLike
```

读取 sidecar 会增加一次 HTTP GET 请求。为最小化开销：
- sidecar 极小（约 30 字节），因此请求很快
- 本地内存缓存可避免对同一路径的重复读取

#### touch

当前会抛出 "not supported"。有了精确 mtime 后，它变得可用：

```typescript
async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
  if (metadata.mtimeMs !== undefined && this.config.preciseMtime) {
    await this.writeMtimeSidecar(path, metadata.mtimeMs);
  }
  // 若未启用 preciseMtime，则为空操作（RS 不支持 touch）
}
```

#### readFileMeta

已有的 `readFileMeta()` 返回类型扩展了一个可选的 `preciseMtime` 字段：

```typescript
async readFileMeta(path: string, opts?: {
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}): Promise<{
  status: number;
  data?: Uint8Array;
  etag?: string;
  lastModified?: string;      // 服务器的 Last-Modified 头
  preciseMtime?: number;      // 来自 .mtime sidecar（若启用）
  contentType?: string;
}>
```

### 2.6 配置

```typescript
interface RemoteStorageConfig {
  // ... 已有字段 ...
  /** 通过 .mtime sidecar 文件启用精确 mtime。默认：true */
  preciseMtime?: boolean;
}
```

- **启用（默认）**：`writeFile()` 会创建 `.mtime` sidecar 文件，`stat()` 读取它们以获得精确 mtime，`touch()` 可用。这确保了 `zen-fs-sync` 的 `FileSnapshot` 比较准确——否则，被服务器覆盖的 `Last-Modified` 值会在每次同步时引发虚假的"已修改"检测。
- **禁用**：无 sidecar 文件，`stat()` 返回服务器的 `Last-Modified`（秒级精度），`touch()` 为空操作。仅适用于只读或非同步场景，此时 mtime 精度无关紧要。

### 2.7 readdir 行为

`.mtime` sidecar 文件会从 `readdir()` 结果中**被过滤掉**。它们由 `RemoteStorageFileSystem` 自身直接（而非经 zen-fs-sync）写入 RemoteStorage，其存在对上层不可见：

```
RemoteStorage（物理上）：
  /documents/note.json
  /documents/.note.json.mtime     ← RSFS 通过自身 PUT 直接写入此文件

上层看到的（经 readdir）：
  /documents/
    note.json                      ← .mtime 被过滤掉
```

这使得 sidecar 文件对上层完全透明：
- `readdir()` 过滤掉任何匹配 `.mtime` sidecar 模式（`<filename>.mtime`）的条目
- `writeFile()` 通过自身的 PUT 请求直接创建 sidecar
- `stat()` 通过自身的 GET 请求直接读取 sidecar，然后将 mtime 合并进结果
- `unlink()` 通过自身的 DELETE 请求直接删除 sidecar

Sidecar 文件从不会暴露给 `zen-fs-sync` 或 `zen-fs-config`。它们是 `RemoteStorageFileSystem` 的内部实现细节。

### 2.8 mtime 如何跨设备传播

借助 `writeFileWithMtime` 接口，mtime 的传播现在是显式的：

```
设备 A 以 mtime=1700000000123 写入 /documents/note.json
  → RSFS PUT 文件内容
  → RSFS PUT .mtime sidecar { "mtime": 1700000000123 }

zen-fs-sync 检测到文件变更（经 shouldSync 的 ETag 比较）
  → syncBidirectional 比较设备 A（IndexedDB）与 RemoteStorage
  → 在源端 stat("/documents/note.json") → mtimeMs=1700000000123
  → 在源端 readFile("/documents/note.json") → data
  → writeFileWithMtimeFallback(target, path, data, 1700000000123)
    → 目标端有 writeFileWithMtime？ → 是 → 以精确 mtime 写入文件 + .mtime sidecar
    → 目标端有 writeFileWithMtime？ → 否 → 普通 writeFile（mtime 丢失，但仍可用）

设备 B 经 RemoteStorageFileSystem 读取 /documents/note.json
  → stat() HEAD 文件 → 服务器 Last-Modified（不精确）
  → stat() GET .mtime sidecar → { "mtime": 1700000000123 }
  → 返回 mtimeMs = 1700000000123（精确）
```

关键点：`zen-fs-sync` 同步的是**文件内容**，并通过 `writeFileWithMtime` 显式传递源端 mtime。在每个设备上，`RemoteStorageFileSystem.stat()` 从 RemoteStorage 读取 sidecar 以返回精确 mtime。sidecar 存在于 RemoteStorage 上，任何连接到同一存储的设备都可访问。

### 2.9 性能影响

| 操作 | 无 preciseMtime | 有 preciseMtime | 差异 |
|---|---|---|---|
| writeFile | 1 次 PUT | 2 次 PUT | +1 次 PUT（约 30 字节） |
| stat | 1 次 HEAD | 1 次 HEAD + 1 次 GET | +1 次 GET（约 30 字节） |
| readFile | 1 次 GET | 1 次 GET | 不变 |
| readdir | 1 次 GET | 1 次 GET | 不变 |
| unlink | 1 次 DELETE | 2 次 DELETE | +1 次 DELETE |

sidecar 约 30 字节，因此网络传输开销可忽略不计。主要成本是额外的 HTTP 往返延迟。

### 2.10 崩溃恢复

如果 `writeFile()` 成功但 `.mtime` sidecar 写入失败（如网络错误），sidecar 将缺失。`stat()` 会退化为使用服务器的 `Last-Modified`——精度较低但并不错误。下一次 `writeFile()` 会重新创建 sidecar。

无需特殊的崩溃恢复逻辑。系统可优雅降级。

---

## 3. 实现总结

### 3.1 对 RemoteStorageFileSystem 的改动

| 方法 | 改动 |
|---|---|
| `constructor()` | 读取 `config.preciseMtime` 标志 |
| `writeFile()` | PUT 之后可选地写入 `.mtime` sidecar；接受 `{ mtime }` 选项 |
| `writeFileWithMtime()` | **新增** —— 实现 `SyncableFS.writeFileWithMtime`；委托给带 `{ mtime }` 选项的 `writeFile()` |
| `stat()` | HEAD 之后可选地读取 `.mtime` sidecar 以覆盖 mtimeMs |
| `touch()` | 通过写入 sidecar 实现，而非抛错 |
| `readFileMeta()` | 在可用时返回 `preciseMtime` 字段 |
| `unlink()` | 若启用了 preciseMtime，同时删除 `.mtime` sidecar |
| `shouldSync()` | **新增** —— 实现 ETag 基线比较 |
| `buildSnapshot()` | **新增（私有）** —— 从文件夹列表构建 ETag 基线 |
| `updateSnapshotForPath()` | **新增（私有）** —— 本地变更后更新基线 |

### 3.2 对其他包的改动

`writeFileWithMtime` 接口被加入 `zen-fs-sync`，并在 `zen-fs-config` 中实现，以在整个同步栈中保留 mtime：

| 包 | 改动 |
|---|---|
| `@zenfs/core` | 无 |
| `zen-fs-sync` | 向 `SyncableFS` 接口新增可选 `writeFileWithMtime`；在 `copyFile`、`syncOneWay`、`writeFileBoth` 中新增 `writeFileWithMtimeFallback` 辅助函数 |
| `zen-fs-config` | 三个适配器（`backendToSyncableFS`、`zenfsPromisesToSyncableFS`、`cachedFSToSyncableFS`）均实现 `writeFileWithMtime`；`backend-registry.ts` 的 `writeFile` 通过 `touch()` 传递 mtime |
| `zen-fs-cache` | 无 —— sidecar 文件即普通文件 |

### 3.3 新增导出

无需新增导出。`shouldSync()` 由 `zen-fs-sync` 通过 `SyncableFS` 接口的鸭子类型（duck-typing）发现。`preciseMtime` 是现有 `RemoteStorageConfig` 上的一个配置选项。

### 3.4 使用示例

```typescript
import { RemoteStorageFileSystem } from 'zen-fs-remotestoragejs';

const fs = new RemoteStorageFileSystem({
  href: 'https://storage.example.com/bob',
  token: 'bearer-token',
  preciseMtime: true,    // 启用精确 mtime
});

// writeFile 自动创建 .mtime sidecar
await fs.writeFile('/documents/note.json', JSON.stringify({ text: 'hello' }));
// → PUT /documents/note.json
// → PUT /documents/.note.json.mtime  { "mtime": 1700000000123 }

// stat 从 sidecar 返回精确 mtime
const stat = await fs.stat('/documents/note.json');
console.log(stat.mtimeMs); // 1700000000123（毫秒精度）

// shouldSync 高效地比较 ETag
const changed = await fs.shouldSync();
console.log(changed); // false（自上次检查以来无变更）

// touch 现在可用（写入 sidecar）
await fs.touch('/documents/note.json', { mtimeMs: 1699999999000 });
```

---

## 4. 与 zen-fs-sync 的关系

### 4.1 shouldSync() 如何集成

```
zen-fs-sync SyncPair.watch()
  │
  ├─ 本地后端（IndexedDB） → onChange 回调 → 去抖后同步
  │
  └─ 远端后端（RemoteStorageFileSystem） → 每 pollIntervalMs 轮询 shouldSync()
     ├─ shouldSync() 返回 false → 跳过同步（仅 1 次 HEAD 请求）
     └─ shouldSync() 返回 true → 触发 syncAll()
        ├─ syncBidirectional() 遍历两端文件树
        ├─ 比较 FileSnapshot {path, size, mtimeMs}
        ├─ 双向拷贝已变更文件
        └─（preciseMtime 确保 mtimeMs 比较准确）
```

### 4.2 preciseMtime 如何帮助同步

无精确 mtime：
```
文件在设备 A 以 mtime=1700000000123 写入
  → 同步到 RemoteStorage，服务器设 Last-Modified=1700000005000
  → 同步到设备 B，B 看到 mtime=1700000005000
  → 下次同步：A 为 1700000000123，B 为 1700000005000
  → 同步引擎认为文件"已修改" → 不必要的拷贝
```

有精确 mtime：
```
文件在设备 A 以 mtime=1700000000123 写入
  → .mtime sidecar：{ "mtime": 1700000000123 }
  → 同步到 RemoteStorage（内容 + sidecar）
  → 同步到设备 B（内容 + sidecar）
  → 下次同步：A 为 1700000000123，B 为 1700000000123
  → 同步引擎：未变更 → 跳过
```

---

## 5. 局限性与未来工作

### 5.1 快照的局限性

- **仅内存**：重启即丢失。重启后的首次 `shouldSync()` 返回 `true`，触发一次全量同步扫描。这是可接受的——`syncBidirectional` 会发现无实际变更并快速跳过。
- **无部分快照**：当根 ETag 变化时，会扫描整棵文件树。对于非常大的树，子树剪枝（§1.5）可将扫描限制在已变更的子树内。

### 5.2 精确 mtime 的局限性

- **额外的 HTTP 请求**：每次 `writeFile` 和 `stat` 都需要一次额外请求。对于写入密集型负载，可考虑批量更新 sidecar。
- **Sidecar 可见性**：`.mtime` 文件会出现在 `readdir()` 中。调用方如需可自行过滤。
- **非原子写入**：文件内容与 sidecar 通过两次独立的 PUT 写入。两者之间的崩溃会导致 sidecar 缺失。优雅退化为服务器 `Last-Modified` 可处理此情况。

### 5.3 未来：批量 mtime 清单

可以用每个目录一个清单文件来替代"每文件一个 sidecar"，从而批量保存所有 mtime：

```
/foo/.mtime-manifest.json    ← { "bar.json": 1700000000123, "baz.json": 1699999999000 }
```

这能减少 HTTP 请求（每目录 1 次而非每文件 1 次），代价是更新逻辑更复杂。如果逐文件 sidecar 被证明过于频繁，可作为未来的优化方向考虑。
