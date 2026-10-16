# Windows 支持实施计划

基于提交 `a37d9df` 制定，日期为 2026 年 10 月 15 日；状态更新于 10 月 16 日。当前为**候选实现，本地与远程实机复验已完成**。sourceHash=`7a37175b2b859c6dfb16b5abc4881b9c873924725b2ac66147b862afcdbae626` 的双 native、Ubuntu 24.04 规范公共 JAR 与六包已冻结，verified SHA=`c4ca2b043bbda20be4569a7c10f79d8d070817e41bb678e209056bdaf9f8dcf7`；增强安装四格及 Rust/Java/JDK/SDK/发布脚本验证通过。

Ubuntu 24.04 最终九项真实游戏场景全部符合预期（8 正常 pass + 1 预期失败，11.3 分钟，0 retry），16个测试JVM全部消失、registry为空、自有容器已停止。Windows 19 条定义为16正常通过、1预期失败取证、2 Linux skip，exit0/18.9分钟，19附件完整，十轮20次关闭均正常，测试进程与registry清理已核验。正式修复仅将默认宽限从10秒提高至30秒，Unix signal/EGL路径不变。历史失败与实验身份继续保留；GitHub与真实Windows磁盘耗尽尚未验收，保持未发布候选状态。详见 [验收记录](windows-validation.md)。

目标是在保留现有 Linux 行为的基础上，提供可通过 npm 安装的 Windows 原生驱动，使服务端、隐藏窗口客户端、Playwright fixture 和 MCP 工作流在 Windows 上完成启动、自动化、证据采集和正常退出。按一名熟悉仓库的开发者估算，首版约需 **12–20 人日**，其中前 **1–2 人日**用于验证图形方案。

## 首版范围与交付条件

| 项目 | 首版目标 |
| --- | --- |
| 操作系统 | Windows 11 x64；Linux 继续保持现有 Ubuntu 24.04 x64 基线 |
| 游戏与运行时 | Minecraft 1.21.1、NeoForge 21.1.233、Java 21 JDK |
| Node | 复用当前最低版本 22.14.0 与已固定的 Node 24 构建版本，分别执行安装烟测 |
| 客户端 | 已登录桌面会话，具有可创建 OpenGL 3.2 core 上下文的 GPU 驱动 |
| 显示方式 | Windows 隐藏窗口；Linux 保留当前 EGL 无窗口后端 |
| 渲染配置 | Windows 支持 `device = "auto"` 和 `"gpu"`；`"software"` 与 `"index:<n>"` 明确报不支持 |
| 自动化 | 服务端控制、客户端连接、UI 输入、截图、录像、音频采集和基础 cinema 工作流 |
| 生命周期 | 正常退出可等待；超时可清理进程树；强制退出有明确失败结果 |
| npm 发布 | 保持现有六个包，安装无需 Rust、Gradle 或安装后下载原生驱动 |
| 用户权限 | 普通用户运行；MSVC、Rust 与 Gradle 仅供构建者使用 |

首版暂不承诺 Windows ARM64、Windows Server 无桌面会话、系统服务会话、RDP 断开后的渲染、软件光栅化、指定物理 GPU，以及 Windows 与 WSL 同时共享同一个运行目录。GPU 兼容范围按实际测试的厂商和驱动记录声明，不泛化为所有显卡均已验证。

交付成立必须同时满足：Windows 安装烟测通过、真实客户端与服务端测试通过、关闭后无残留 JVM、世界和覆盖率正常保存、Linux 回归通过。仅能编译或完成 driver ping 不构成 Windows 支持完成。

## 已确认的改造起点（a37d9df 快照）

| 位置 | 当前行为 | 实施影响 |
| --- | --- | --- |
| [lib.rs](../crates/blockwright/src/lib.rs) 与 [binary.ts](../packages/blockwright-client/src/binary.ts) | 明确拒绝非 Linux x64 | 源码平台限制和二进制定位需要同步调整 |
| client 与 MCP 的 package.json | `os` 仅包含 Linux | 最终安装验证前增加 Windows 发布元数据 |
| [process.rs](../crates/blockwright/src/process.rs) | 读取 `/proc`，通过 `libc::kill` 发送信号 | Windows 需要独立进程检测和终止实现 |
| [driver/mod.rs](../crates/blockwright/src/driver/mod.rs) 与 [driver/launch.rs](../crates/blockwright/src/driver/launch.rs) | Unix 信号、进程组和 Unix 退出状态 | 需要平台化生命周期实现 |
| [driver.ts](../packages/blockwright-client/src/driver.ts) | `close()` 对驱动发送 SIGTERM | Windows 正常关闭必须改用可协作的退出路径 |
| [store/mod.rs](../crates/blockwright/src/store/mod.rs) 与 [store/cache.rs](../crates/blockwright/src/store/cache.rs) | flock、Unix 权限、inode 比较、只读硬链接 | 文件锁与文件放置策略需要适配 |
| [engine/launch.rs](../crates/blockwright/src/engine/launch.rs) | 已有 `win_args.txt` 分支 | 服务端参数选择可以复用 |
| [ServerPort.java](../neoforge-agent/src/main/java/dev/blockwright/agent/ServerPort.java) | 游戏实际绑定端口 0 后发布端口文件 | 端口分配无需重新实现；需验证端口文件替换 |
| [managed_client.rs](../crates/blockwright/src/engine/managed_client.rs) | Linux OS 规则、`natives-linux`、写死部分 classpath 分隔符 | Windows 库选择与 JVM 参数需要修正 |
| [ClientOffscreen.java](../neoforge-agent/src/main/java/dev/blockwright/agent/ClientOffscreen.java) | GLFW Null 平台和 Linux EGL 动态加载 | Windows 图形后端为最大技术风险 |
| [ClientExit.java](../neoforge-agent/src/main/java/dev/blockwright/agent/ClientExit.java) | 使用 Linux 动态加载器与 libc 的 `_exit` | NVIDIA EGL 退出补丁只能进入 Linux 后端 |
| [SnippetClasspath.java](../neoforge-agent/src/main/java/dev/blockwright/agent/SnippetClasspath.java) | 手工剥离 file URI 等前缀 | 需要覆盖盘符、编码和 UNC 路径 |
| [release-lib.mjs](../scripts/release-lib.mjs)、[pack-check.mjs](../scripts/pack-check.mjs) | 平台相关路径参与哈希，按斜杠拆归档名，直接执行 npm 与 bin 脚本 | 需要跨平台路径、命令调用和打包验证 |
| [Playwright fixture](../packages/blockwright-test/src/index.ts) 与 [MCP session](../packages/blockwright-mcp/src/session.ts) | 主要工作流同时启动客户端与服务端 | 服务端阶段只算内部里程碑 |

评估时的 Windows 内存探针曾复现两个问题：旧 `instanceAlive(process.pid)` 对自身活进程返回 false；`archive.split("/").at(-1)` 不能提取 Windows 归档文件名。两处现已修复并通过回归；完整交付仍按以下阶段的验收条件判断。

## 关键设计

### 平台实现集中管理

在 Rust 中增加平台模块，将进程、退出状态和文件系统操作封装为内部接口，调用方不再直接使用 Unix API。建议目录为 `platform/mod.rs`、`platform/unix.rs`、`platform/windows.rs`，允许随实现规模进一步拆分。

平台身份使用统一的 OS 与架构映射，例如发布目标 `linux-x64`、`win32-x64`，分别映射 Rust target。Node 与 Rust 的映射需要有一致性测试。运行时缓存键包含平台、架构与缓存格式版本，避免采用另一平台生成的启动文件和本地库。

源码级 Windows 入口随平台实现逐步开放；正式文档和 npm 发布支持声明在最终验收后更新。过渡阶段 Windows 的独立 Java/Rust 探针及 TypeScript 工具验证使用临时开发工具目录，不依赖强制安装 Linux 发布包。

### 正常关闭与强制清理分开处理

Windows 正常关闭顺序为：

1. SDK 停止接受新请求，并发出驱动关闭意图；优先复用 stdin EOF，原生驱动需要能在执行请求期间独立感知 EOF。
2. 驱动通过现有 agent 控制连接新增内部 `lifecycle.shutdown` 请求。agent 先确认接收，再在正确的游戏线程安排退出。
3. 服务端完成世界保存，客户端完成游戏退出，覆盖率和日志落盘；驱动等待进程结束。
4. 只有超时或无响应时，才强制终止该实例的进程树；强制终止的结果必须包含 `killed = true`、`success = false`。
5. 等待输出管道结束后收集崩溃证据，按保留策略清理目录和 registry，最后退出驱动。

Windows 为每个受管游戏进程树持有 Job Object，使用关闭句柄时清理进程的能力作为异常退出兜底。创建子进程与加入 Job 的竞态必须在实现中解决，不能让提前产生的后代逃逸；Job 句柄不应继承到 JVM。加入 Job 失败时，终止刚创建的进程并报告启动失败。参见 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

现有同步 `BlockwrightDriver.close(): void` 保留为“发起关闭”。新增 `closeAsync(): Promise<void>`，重复调用返回同一个关闭过程；fixture、MCP、launchPair 和安装烟测改为等待它。关闭超时或清理失败必须可观测，不能吞掉后声称关闭完成。显式强杀驱动仍作为异常路径测试。Windows 下 Node 的 SIGTERM 会强制终止进程，不能承担上述正常退出过程，参见 [Node 子进程文档](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html#subprocesskillsignal)。

需要保证最后一个实例释放时的自动关闭、retain/release、正在进行的 launch 与显式关闭不会互相重入或漏清理。启动过程中对已经创建的 JVM、Job 和安装器进程必须始终有明确所有者，直到成功登记或失败回收。

### Windows 先采用独立文件副本

Windows 首版在实例与 store 之间使用独立副本；可使用能够保证独立写入的 reflink 优化，但不默认创建硬链接。Linux 保留当前 reflink、硬链接和复制策略。

只读源文件复制到独立目标后，再按文件用途设置目标权限。替换、清除只读属性和删除只操作已确认独立且属于当前操作的目标。不能为删除一条硬链接而解除整个共享文件的只读保护。参见 [Windows 硬链接属性语义](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions)。

共享锁与排他锁优先使用当前固定 Rust 工具链支持的 `std::fs::File` 锁接口，并测试 Windows 的句柄打开方式和锁冲突。确有缺口时才增加平台实现。参见 [Rust File 锁接口](https://doc.rust-lang.org/std/fs/struct.File.html#method.lock)。

临时文件在目标旁创建并发布。替换已有文件、只读目标、打开中的文件和中断恢复都要测试；失败时保持原文件可用并清理临时文件，不使用无限重试。缓存版本迁移采取重新构建运行时，不原地改写旧运行时。未知平台或无法确认进程状态的 registry 记录应保守保留，不能当作已死亡进行 GC。

### 图形后端与受管客户端状态分离

Java 中区分“由 Blockwright 管理的客户端”和“采用 Linux EGL 的客户端”。音频 loopback、输入注入、证据采集仍属于受管客户端能力，不能随 Windows 关闭 EGL 分支而一起失效。

Linux 后端保留 Null 平台、手动 EGL context 与退出补丁。Windows 后端使用 GLFW 的 Win32/WGL 路径、隐藏窗口和游戏自己的 framebuffer 进行渲染及采集。GLFW 支持以隐藏窗口承载离屏上下文，但仍需要处理事件，参见 [GLFW 离屏上下文](https://www.glfw.org/docs/3.4/context_guide.html#context_offscreen)。

Windows 后端必须避免现有 hide/show/focus 补丁把窗口重新显示或抢占用户焦点。context 创建、swap、事件处理和释放由对应后端控制；NeoForge early window 继续关闭。上下文报告保留现有事件兼容性，增加 backend/platform 信息。

不默认要求用户新增 backend 配置。按平台选择后端，保留现有 device 字段；Windows 对暂不支持的 software/index 配置在下载或启动游戏前给出具体错误，不静默改用 GPU。auto/gpu 使用系统选定的 GPU，实际 renderer 和 OpenGL 版本写入 trace。

### 原生包先保持六包结构

首版保持当前六个 npm 包，在 client 包中同时包含两个驱动与一份公共 agent JAR，避免为两个平台立即引入额外发布包和安装脚本。

建议的 client 构建目录：

```text
dist/
  index.js
  index.d.ts
  native/
    linux-x64/blockwright
    win32-x64/blockwright.exe
  agents/
    blockwright-neoforge-agent-VERSION.jar
    blockwright-coverage-VERSION.jar
  third-party/
  bundle-manifest.json
```

构建拆为平台原生构建、公共 Java 构建、组装完整发布包三个步骤。两个原生构建任务产出明确 target 的二进制、版本、sourceHash 和许可证清单；组装时要求同版本、同源码身份，缺少任一目标均失败。公共 JAR 采用一份规范构建产物，两平台都验证该产物可用。

manifest 增加格式版本和目标信息，所有内部路径使用正斜杠。sourceHash 的相对路径表示统一；源码行尾通过明确的 Git attributes 约束，二进制仍按原始字节计算哈希。发布输入必须包含全部目标，不能因为只在当前机器运行就忽略另一目标的缺失。

`build:release` 保留为最终组装入口；增加平台构建入口并在文档中说明输入产物。开发构建可以只生成当前平台，但这种不完整 bundle 不可通过最终 pack 校验。

## 分阶段任务

各阶段工时为增量，默认由一人顺序执行。图形探针在独立最小程序中完成，因此不依赖先移植整个 Rust 驱动。

本轮用户已批准实施并要求使用 subagent，实际按 Rust 平台/存储、SDK/发布与 Java 图形任务并行推进。以下 `[x]` 表示该项实现及已注明的局部验证完成；阶段末尾的**验收**和文末发布清单仍是独立交付条件。未勾选项可能已编码，但完整实机或发布验证尚未完成，不计作通过。

| 阶段 | 当前状态 |
| --- | --- |
| P0 | 已通过 RTX 4070 实机图形/音频探针，5×120 帧；依赖与环境已记录 |
| P1 | 已实现；Windows/Linux Rust、SDK 生命周期及辅助进程树回归通过 |
| P2 | 文件系统、服务端保存重开/EOF/Job 回收、真实覆盖率与扩展 lifecycle/offscreen 回归通过；启动取消重试、主线程阻塞超时强杀、真实 JVM fatal-error 日志/摘要/PID 清理及失败目录保留通过；磁盘耗尽等验收待补 |
| P3 | metadata、classpath、URI 与 argfile 已实现，真实客户端启动、JDK 21 CP936 中文/空格及 >32K 参数、中文目录中的真实游戏 snippet 均通过 |
| P4 | 最终客户端/UI/截图、视频/音频、中文目录 MCP/cinema、十轮启停与fixture取证均符合预期；v3采样14个GLFW client、4654窗口观察含完整十轮，未观察到可见/前台窗口；不是无间隙逐帧证明 |
| P5 | 当前7a双native、Ubuntu24规范公共JAR、最终六包/verified SHA冻结并核验；Windows/Ubuntu24×Node22/24增强安装四格通过 |
| P6 | 当前构建/安装回归、Ubuntu24九场景与Windows17expected/2Linux skip全部符合预期；原始产物、附件与清理证据已归档核验；GitHub未执行，真实Windows磁盘耗尽未实测，历史失败保留 |

| 阶段 | 预计工时 | 前置条件 | 完成标志 |
| --- | --- | --- | --- |
| P0 图形与工具链验证 | 1–2 人日 | Windows GPU 桌面测试机 | 隐藏窗口图形方案成立 |
| P1 平台层与生命周期 | 2–3 人日 | P0 | Windows 原生驱动可编译，关闭和进程树测试通过 |
| P2 文件系统与服务端 | 2–3 人日 | P1 | 服务端真实启动、保存、关闭和 GC 通过 |
| P3 启动器与路径处理 | 1–2 人日 | P2 | Windows 客户端启动参数及 Java 编译路径正确 |
| P4 客户端功能整合 | 2–3 人日 | P0 与 P3 | 隐藏窗口客户端完成自动化和媒体验证 |
| P5 构建与安装验证 | 2–3 人日 | P4 | 同一组完整 npm 归档在两平台安装通过 |
| P6 完整回归与发布准备 | 2–3 人日 | P5 | Windows 实机与 Linux 回归全部通过 |

总计 12–19 人日，按 12–20 人日安排。服务端内部里程碑约在累计 5–8 人日达到。图形方案需要重选、缓存策略出现额外缺口或 GPU 测试环境不能稳定运行时，重新估算受影响阶段；可另预留 3–5 人日风险缓冲，不把缓冲算作已经承诺的功能工作量。

### P0 图形与工具链验证

- [x] 准备 Windows 11 x64 普通用户测试环境，核对 Java/Javac 21、固定 Node/Rust 版本、MSVC 链接工具、Gradle wrapper 与 FFmpeg。
- [x] 建立独立的 LWJGL/GLFW 探针，使用与游戏版本一致的库；创建 OpenGL 3.2 core 隐藏窗口，并从 framebuffer 读取可验证像素。
- [x] 验证窗口始终不可见、不抢焦点、持续处理事件、framebuffer 尺寸可用、连续运行后可正常释放。（独立探针 5 轮，每轮 120 帧；完整游戏流程另见 P4。）
- [x] 验证对应 Windows OpenAL 本地库支持当前 loopback 音频路径。
- [x] 记录 Windows 版本、GPU 厂商、驱动、GL renderer/version、native 库版本与探针结果。
- [x] 确认 Windows release 可执行文件需要哪些外部运行库，作为 P5 的安装检查输入。（CRT 静态链接，PE 仅导入 Windows 系统 DLL。）

产物建议放在新增 `scripts/probes/windows-display/`，报告只记录验证环境和结果，生成文件进入忽略目录。

**验收：**非黑屏像素读取通过；隐藏运行和正常退出重复通过；OpenAL loopback 可输出所需格式。若图形探针失败，先修正或重选方案，再进入客户端支持实施，不继续假定原方案成立。

### P1 平台层与生命周期

主要文件：新增 Rust platform 模块；`lib.rs`、`process.rs`、`driver/mod.rs`、`driver/launch.rs`；`store/mod.rs`、`store/cache.rs`、`engine/mod.rs` 中的 Unix 编译依赖；Java `Control.java`、`Lifecycle.java`，以及 client 的 `driver.ts`、`launch-pair.ts`、`types-launch.ts`、`registry.ts`。

- [x] 将 Unix API 移入条件编译模块，Windows 专用依赖使用 target 条件声明；调整源码编译与 SDK 平台入口。
- [x] 同步切分文件系统的 Unix 编译依赖，提供真实可用的 Windows 基础锁、复制和权限操作；不以空实现或跳过模块换取编译通过。P2 再完成文件系统语义、恢复和 GC 验收。
- [x] 通过进程句柄检测 Windows 活进程，区分已退出、无权限和未知状态；核对 PID 与启动身份，避免 PID 复用误判。
- [x] 实现每个受管进程树的 Job 管理，覆盖 JVM、安装器和启动失败路径。
- [x] 在 agent 控制协议增加内部 shutdown 请求，在服务端/客户端正确线程上安排退出，覆盖冻结 tick 状态。（Java 测试与真实服务端通过；真实客户端关闭另见 P4。）
- [x] 增加 SDK `closeAsync()`，使 EOF、关闭超时、驱动退出码和清理结果可等待；close 保持可重复调用。
- [x] 处理启动中取消、请求中 stdin 关闭、最后实例释放、retain/release 与关闭状态的竞态。（包括输入队列过载与 stdout 背压复现回归。）
- [x] 规范 Windows 的 close result：无 POSIX signal 时为 null；已退出保留真实状态，强杀不可报告成功。
- [x] 修正 SDK registry 存活检测及 host 诊断；jcmd 使用正确的 `.exe` 定位，无法提供的负载指标明确省略。
- [x] 测试辅助进程改用跨平台实现，避免依赖 shebang、chmod、sh、负 PID 和 `/dev/null`。

**验收：**Windows target 编译通过；正常关闭、超时强杀、强杀驱动、启动失败、并发关闭和重复关闭测试通过；10 次测试辅助进程树创建/销毁无残留；Linux 信号测试继续通过。

### P2 文件系统与服务端

主要文件：`store/mod.rs`、`store/cache.rs`、`store/gc.rs`、`engine/mod.rs`、`engine/launch.rs`、`registry.rs`、`http.rs`、`mods.rs`，以及 client 的 `seed.ts`、`registry.ts`。

- [x] 保留共享、排他与非阻塞锁语义，测试独立进程争用同一store和instance。（store跨进程回归与最终7a三个独立driver的instance争用通过：同名/大小写与配置前缀别名均立即拒绝，原owner释放后新driver重获；Java21阻塞installer fixture，无真实Minecraft运行声明，所有自有driver/installer已退出。证据见验收记录。）
- [x] 为 Windows 文件放置实现独立复制策略，覆盖 mod JAR、runtime tree 和 writable seed；同步处理 set_readonly、copy_over 与 same_file。
- [ ] 实现受控的替换及清理路径，测试目标只读、句柄占用、磁盘写入失败后旧文件保留和暂存文件回收。（只读、占用句柄与失败替换回归已通过；真实磁盘耗尽故障未验收。）
- [x] 运行时缓存键增加 OS/arch/schema，旧运行时重建；记录不支持跨 Windows/WSL 共享运行目录的范围。
- [x] 对 Windows 保留名、尾随点或空格、路径大小写和实例名清洗进行一致性验证；使 seed 路径与 Rust 实例路径一致。
- [x] 进程状态未知时禁止回收相关实例；失败实例、keepInstanceDir 与复用实例语义保持一致。
- [x] 使用现有 win_args.txt 分支，真实安装并启动服务端，验证端口文件发布、世界控制、正常保存与再次打开。
- [x] 验证覆盖率生成，以及 trace、日志和 fatal-error 文件在句柄释放后可读、可按策略清理。（真实 Windows HTML/XML/LCOV、trace/清理回归和 JVM fatal-error 资格均通过；实际 `hs_err` 可读、摘要含异常/frame，返回 success=false/killed=false 并保留失败目录，PID 已消失。）

**验收：**两个实例不能通过修改自身文件改变 store 或对方实例；同名并发启动被拒绝；GC 不删除活实例；服务端写入方块后关闭再启动仍可读到；保存和覆盖率成功，关闭后无 JVM 残留。

服务端阶段使用低层 SDK 验证即可。现有 launchGame/createGameTest/MCP 成对启动工作流需等 P4 完成，不为此阶段强行扩大公共 fixture API。

### P3 启动器与路径处理

主要文件：`engine/managed_client.rs`、`engine/launch.rs`、`config.rs`、`coverage.rs`、Java `SnippetClasspath.java` 及对应测试。

- [x] OS rules 按当前平台选择，Windows x64 接纳正确规则和 natives-windows classifier；不解压其他架构 DLL。
- [x] 使用平台对应的 classpath separator；保留已经使用 env::join_paths 的正确逻辑，修正占位符替换。
- [x] 校验 Windows 特有 metadata 参数和本地库搜索目录。（fixture 与真实客户端启动通过。）
- [x] 对长 classpath 采用 Java argument file，处理空格、引号、反斜杠、Unicode 与换行规则；禁止拼接成 shell 命令。（真实 JDK >32K/中文/空格通过；Unicode 受 Windows ANSI code page 限制，详见验收记录。）
- [x] 正确解析 file URI、jar/union 外层包装、盘符和 percent encoding；覆盖 UNC 解析，UNC 上的游戏运行暂不列入承诺。
- [x] 核对Windows扩展路径前缀在配置、Java参数和证据路径中的行为。（正常config只absolute/join；内部canonicalize仅用于cache身份/same_file/Win32替换，不进入常规Java参数。Java21/ACP936实测普通classpath搭配显式`\\?\`文件I/O及`@argfile`通过，显式前缀JAR/目录classpath和`-jar`失败；要求常规盘符绝对路径，不承诺前缀游戏根、UNC游戏及所有超MAX_PATH场景。）
- [x] 配置阶段拒绝 Windows software/index；TOML 示例使用适合 Windows 的路径写法。
- [x] 增加真实 JDK snippet 编译验证，确保找到游戏、mod 与 agent API 类路径。（完整发布 bundle 在 CP936 中文空格目录中的 MCP server snippet 已实际编译执行。）

**验收：**metadata fixture 精确选中 Windows 库；空格和中文路径下启动参数正确；超过普通命令行长度的参数能通过 argfile 启动；Java snippet 实际编译执行通过。

### P4 客户端功能整合

主要文件：`ClientOffscreen.java`、`ClientExit.java`、`ClientAudio.java`、`ClientFrames.java`、相关 Mixin、`engine/launch.rs`，以及 `live/offscreen.spec.ts`、`live/render-capture.spec.ts`、`live/minecraft-ui.spec.ts`。

- [x] 接入独立的 Windows 隐藏窗口后端；将 Linux EGL 初始化与 Linux _exit 补丁限制在对应后端。
- [x] 调整 GLXMixin、WindowMixin 与 RenderSystemMixin，按后端处理 context、swap 与事件循环。
- [x] 保持受管客户端音频 loopback，验证无物理音频输出；输入状态与 OS 窗口焦点解耦。（ALSOFT null/loopback 路径与真实非静音采集通过，focused=false 时 UI 输入仍通过。）
- [x] 客户端进入服务器后验证玩家状态、冻结与推进 tick、UI 打开/点击/拖动、截图及 framebuffer 尺寸。（Windows 基础 live 通过；更多路径和窗口属性另做强化资格。）
- [x] 验证录像不是黑屏，音频不是空文件，FFmpeg 和 ffprobe 路径可配置且包含空格时可执行。（当前最终Windows六包：公开media.probeVideo用两个含空格绝对路径读取新MP4，5s/blackFraction0/blackCheck=ok，解码音频RMS0.0201825；不增加unique场景数。）
- [x] 验证基础 camera/cinema 功能、失败截图、崩溃证据及客户端正常退出。（四帧 cinema、正常 pair close、启动取消/超时 JSON、真实 JVM fatal-error 日志/摘要及 fixture 取证 3/3 已通过；预期失败的 observation、容器 diamond×7、玩家实体与 5 张 PNG 附件已验证。）
- [x] 将 offscreen 测试拆成公共行为与后端专用断言；Linux 无显示服务器和 software 测试继续保留，Windows 使用独立配置。（Windows 公共 offscreen 通过且 software 专用项提前 skip；远程 Arch Linux auto/software 2/2、4.4 分钟通过，auto实际回退llvmpipe，显式software无degraded；原始report/PNG/MP4/trace回收，不宣称物理Linux GPU或独立音频RMS已验收。）
- [ ] 全流程确认窗口不会短暂显示、抢焦点或因失焦停止渲染。（已完成真实游戏离散采样：2557次/4654窗口观察、14个GLFW client及完整十轮，visible/foreground0；目标200ms、实际max1025ms、发现周期1s。不能排除间隙瞬时变化，不能作全生命周期逐帧保证。）

**验收：**真实客户端连入真实服务端；截图有有效像素，录像可解码且不是全黑；音频和 UI 输入通过；正常退出不出现 JVM fatal-error 文件。只验证窗口隐藏不能替代这些功能验收。

### P5 构建与安装验证

主要文件：根及各包 `package.json`；client 的 `binary.ts` 与 Shell 构建脚本；`scripts/build-release.mjs`、`release-lib.mjs`、`check-package.mjs`、`pack-check.mjs`、`package-smoke.mjs`、`release.test.mjs`、`third-party.mjs`；新增构建/组装脚本及必要的 `.gitattributes`。

- [x] 将 Shell 逻辑迁至 Node 脚本或受控平台入口；Windows 使用 Gradle wrapper bat，原生命令和批处理脚本分别处理。
- [x] npm 调用优先通过当前 Node 执行 npm 的 JavaScript CLI；tsc 与 MCP 烟测通过 Node 执行 JS 入口，避免直接 execFile 批处理文件。
- [x] 修改二进制选择：显式 driverPath、环境变量、当前平台 bundle、PATH 回退保持既定优先级；明确不支持的平台和缺失 bundle 错误。
- [x] 将平台构建与组装分离，最终 bundle 包含两个目标；分别保存原生许可证并复用公共 Java 许可证。
- [x] manifest 校验版本、sourceHash、目标、全部二进制与 JAR 哈希；保留缺失、陈旧、篡改和源码变化的失败测试。
- [x] 修正 archive basename、manifest 路径、源码哈希的跨平台差异。
- [x] 替换 npm test 中依赖单引号 glob 的写法，使用明确跨平台的测试发现方式；fake driver 通过 Node 与参数启动。
- [x] 在已有原生实现通过后，调整 client/MCP 的 os 元数据并同步 lockfile。
- [x] 当前7a最终同组六包在仓库外consumer完成imports、严格NodeNext声明导入/Playwright示例类型编译、Java sources、driver version/ping、MCP help/stdio握手。（Windows/Ubuntu24×Node22/24新四格日志已核验，TS5.9.3/types20.19.41，不依赖仓库node_modules。）
- [x] 当前7a用户安装使用ignore-scripts，原生驱动/JAR完整，Windows静态CRT/系统DLL与Linux tar0755验证通过；六tgz与verified哈希已重新核验。

**验收：**两个平台分别以 Node 22.14.0 与固定 Node 24 安装同一归档集通过；用户无需 Rust/Gradle；缺少或修改任一目标的 bundle 无法通过最终 pack 检查；正常 Windows 安装无需 force。

### P6 完整回归与发布准备

主要文件：`.github/workflows/ci.yml`、`.github/workflows/live.yml`，新增 Windows live workflow；`live/helpers.ts`、生命周期/覆盖率/媒体/MCP 测试；README、CONTRIBUTING、environment、releasing、各包说明和 CHANGELOG。

- [x] 普通 CI 增加 Windows 原生构建、Rust/Java/TypeScript 测试和安装烟测；保留 Linux secrets 和现有发布检查。（workflow 已接入，尚未在 GitHub 运行。）
- [x] 构建任务分别上传 target 产物，组装任务生成唯一 npm 归档集，两平台安装任务消费同一组归档和哈希。（workflow 已接入，实际 GitHub 运行待验收。）
- [x] Windows 客户端 live 测试在具备 GPU 和交互式桌面会话的测试机上执行；普通托管 runner 不能替代客户端图形验收。（本地 RTX 4070：基础 5/5、强化 3/3、扩展 9-pass/1-Linux-skip；GitHub self-hosted workflow 尚未执行。）
- [x] Windows 与 Linux 的真实游戏 workflow 都保留显式 EULA 接受输入，常规 CI 不启动真实游戏。
- [x] 生命周期测试拆分平台信号实现，使用“正常关闭”和“异常终止”行为验收，避免在 Windows 复用负 PID 或 SIGTERM 的 Linux 语义。
- [x] 验证真实 server/client 连续 10 次启动与关闭、失败重试、启动中取消、超时、强杀驱动和保留实例；较长循环作为实机资格验证单独配置超时。（连续十轮与基础 Job 回收已通过；故障资格 2/2、36.3 秒，启动取消返回可观察 code=75 后同目录 retry 成功，阻塞主线程超时返回 killed=true/success=false 并保留目录、清除 PID/registry；JSON 已归档。）
- [x] 在含空格和中文的本地路径验证真实游戏、Java snippet、证据文件和编码器。（完整发布 bundle、CP936，首项强化资格通过。）
- [x] 更新 Windows 安装步骤、Java 路径示例、device 限制、MCP 主机启动方式和构建产物组装说明。（已核对 README、六包 README、CONTRIBUTING、environment 和 releasing；environment 含 Windows JDK TOML 与当前两平台 workflow 范围；候选身份保持不变。）
- [ ] 在所有发布条件通过后更新支持矩阵和 CHANGELOG，核对手动发布的版本与 verified.json；发布动作继续沿用仓库现有人工流程。

**验收：**Windows 的真实 Playwright fixture 与 MCP 启动/操作/关闭通过；Linux release:check 和相关 live 回归通过；记录实机与驱动环境、归档哈希、世界/覆盖率保存结果及进程残留检查。

## 验证矩阵

| 验证项目 | Linux 普通 CI | Windows 普通 CI | Windows GPU 实机 |
| --- | --- | --- | --- |
| Rust 编译与进程/文件系统测试 | 必须 | 必须 | 使用已验证二进制 |
| Java 测试与模块编译检查 | 必须 | 必须 | 验证规范 JAR 可运行 |
| TypeScript 测试与 live 类型检查 | 必须 | 必须 | 必要时补充 |
| 六包安装、声明、driver ping、MCP 握手 | Node 22 与 24 | Node 22 与 24 | 使用同一归档 |
| 真实服务端保存、重启与覆盖率 | 显式 EULA 的 live job | 可独立设显式 EULA job | 必须 |
| 客户端、UI、截图、视频和音频 | 保留现有 Linux live | 不据此声明图形通过 | 必须 |
| 强杀驱动与 JVM 清理 | live + 辅助进程测试 | 辅助进程测试 | 必须 |
| Linux software/EGL 行为 | Linux live 必须 | 不适用 | 不适用 |
| Windows software/index 错误提示 | 配置测试可覆盖 | 必须 | 无需下载即可验证 |

回归关注行为与数据，不以命令退出码代替游戏结果。视频必须验证解码和非黑屏；保存必须通过重新打开世界确认；无残留必须覆盖子进程；缓存隔离必须验证其他实例与 store 的内容未变化。

## 建议的提交拆分

1. **Windows 图形探针与环境记录**：P0 独立验证，不改变正式支持声明。
2. **跨平台进程层与可等待关闭**：P1，包含 Java shutdown、SDK 生命周期与对应测试。
3. **Windows 文件系统与服务端**：P2，包含锁、复制策略、缓存平台键和服务端验收。
4. **Windows 启动器与 Java 路径**：P3，包含 metadata、DLL、argfile 和 snippet 编译。
5. **Windows 客户端后端**：P4，包含图形、输入、音频、媒体及对应 live 配置。
6. **跨平台 bundle 与安装验证**：P5，包含全部目标组装、npm 元数据和完整性校验。
7. **Windows CI 与发布文档**：P6，将端到端证据和正式支持矩阵一同交付。

每次提交带上其阶段的行为验证，并对触及的 Linux 路径执行回归。部分完成的 Windows 开发构建不得作为完整发布包发布。

## 风险与处理

| 风险 | 触发信号 | 处理方式 |
| --- | --- | --- |
| 隐藏窗口无法稳定渲染 | 黑屏、尺寸为零、失焦暂停或需要显示窗口 | 在 P0/P4 调整后端、framebuffer 与输入实现；必要时重新估算客户端阶段 |
| 正常关闭退化为强杀 | 世界未保存、覆盖率为空、驱动先退出 | 优先修复 shutdown 协议、等待顺序和 Job 生命周期，发布前必须解决 |
| 复制策略磁盘成本过高 | 多实例占用或启动耗时明显增加 | 记录同机器冷/热启动与磁盘占用，后续再引入经隔离验证的 reflink/硬链接优化 |
| 文件替换和清理不稳定 | sharing violation、残留暂存文件 | 先释放句柄，有限重试瞬态错误；保留旧数据并报告失败 |
| 平台缓存被混用 | 错误 native、启动参数或 GC 判断 | 平台化 runtime key；拒绝不明运行时；文档明确独立运行目录 |
| 打包漏目标或混版本 | 当前机器能跑，另一平台安装失败 | 统一组装、校验目标完整性，并让两平台消费同一归档集 |
| 缺少可靠 GPU 测试环境 | 普通 CI 全绿但没有客户端实机结果 | 保留候选状态，直到交互式 GPU 环境验收通过再声明支持 |
| 工期超出初估 | P0 失败或新增平台语义缺口 | 按阶段证据调整剩余工期，保留可独立验收的服务端里程碑 |

## 发布完成清单

- [x] 当前Linux/Windows原生驱动与规范公共JAR来自同一版本及7a源码身份；最终native/JAR/六包/verified SHA已冻结核验。
- [x] 六个 npm 包的版本、依赖与 lockfile 一致。（完整 pack-check 通过。）
- [x] 两平台安装验证使用当前同组六包，hash已记录。（7a最终Windows/Ubuntu24×Node22/24增强四格通过，运行与独立类型编译均通过。）
- [x] Windows 普通用户环境可启动真实客户端和服务端。（基础 live 5/5 与完整 bundle 强化资格 3/3 通过。）
- [x] UI、截图、录像、音频和基础 cinema 操作通过。（视频解码/非黑与真实 PCM RMS、四帧 cinema 已验证。）
- [x] 正常关闭完成世界、日志、覆盖率保存，signal 和 killed 结果准确。（真实方块保存重开、HTML/XML/LCOV 与十轮关闭结果均归档。）
- [x] 异常退出和重复运行没有遗留游戏进程，GC 保留活实例及指定保留的数据。（辅助进程/GC 回归、十轮真实 pair、kill driver、启动取消重试及阻塞主线程超时强杀通过。）
- [x] 空格、中文、长参数与 Java snippet 编译通过。（真实 JDK >32K；CP936 中文空格目录中的 MCP/snippet/cinema 全流程。）
- [x] Windows software/index 提前给出明确错误，实际 GPU 范围与文档一致。（仅记录实测 RTX 4070/驱动；不扩大 GPU 兼容声明。）
- [x] 当前Ubuntu24四spec九项真实游戏场景与产物/清理通过。（11.3分钟、8正常pass+1预期失败、0unexpected/skip/retry；归档SHA已核验，16测试JVM全gone/registry0、own容器已停止。）
- [x] 当前最终Windows17expected/2Linux skip与原始产物、测试进程/registry清理均符合预期。（16正常通过+1预期失败取证、exit0/18.9分钟、19附件完整，16持久trace PID和39采样创建身份均gone，两组有重叠；所有根/嵌套registry为空。）
- [x] README、包说明、MCP 示例、环境和发布文档与候选实测范围一致。（两平台本地验收已完成；正式发布矩阵和CHANGELOG升级仍待GitHub及剩余故障验收。）
- [ ] verified.json 与人工发布输入一致，所有强制验收项完成。
