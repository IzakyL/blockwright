# Windows 支持验收记录

更新于 2026 年 10 月 16 日，时区 Asia/Shanghai。当前为**候选实现，尚未达到发布完成条件**。本记录对应 [实施计划](windows-support-plan.md)，将源码实现、局部验证和完整交付验收分开记录；新增代码或 workflow 不代表相关实机验收已通过。

## 当前结论

Windows 原生驱动、可等待关闭、Job Object 进程树、独立文件复制、平台运行时缓存、Windows 启动参数及隐藏 WGL 后端已实现。历史候选 `a4c251…` 已完成下述 Windows/WSL/Ubuntu 24.04 局部验证，但远程 Linux 实机发现默认 10 秒关闭宽限不足，**旧 bundle 不再作为最终发布候选**。

历史 Windows 基础 live **5/5、9.4 分钟**，强化资格 **3/3、8.7 分钟**，扩展回归 **9 expected/1 Linux software skip、6.6 分钟**，启动取消/超时 **2/2、36.3 秒**，真实 JVM fatal-error **1/1、20.6 秒**，fixture **3/3、1.5 分钟**。各轮有重叠，共 **17 个不同 active 实机场景**，包含一项验证过附件的预期失败。旧六包也通过 Windows/Ubuntu 24.04 容器×Node 22/24 增强安装四格；旧 WSL 两格仅为额外运行烟测。这些证据保留为历史结果，不能替代新源码的最终验收。

相较历史 `a4`，当前正式候选仅将默认关闭宽限从 10 秒改为 30 秒，保留 Unix SIGTERM→有界 SIGKILL 与 EGL 客户端原路径；临时 Unix 服务端 RPC 扩展及其两项测试已撤回。直接对照原 `a4` 源码归档，`driver/launch.rs` 仅两行注释和默认常量不同。当前 native sourceHash 为：

```text
7a37175b2b859c6dfb16b5abc4881b9c873924725b2ac66147b862afcdbae626
```

| 当前候选交付项 | 状态 |
| --- | --- |
| 同源码双 native、规范公共 JAR、完整六包及最终 SHA 冻结 | 已完成；双 native/公共 JAR/verified 均为上述7a sourceHash，最终哈希见下表；旧a4仅作历史记录 |
| Windows 7a Rust/native/SDK | Rust110 lib+24 CLI=134 active/3 ignored，另显式真实JDK资格1/1；两Node SDK各258/258、release tests各9/9、live类型检查通过 |
| Ubuntu 24.04 7a 构建/单元验证 | Rust105 lib+28 CLI=133 active/2 ignored，显式真实JDK资格1/1；Java90条89pass/1 opt-in skip/0fail；两Node SDK各258/258、release tests各9/9、live类型检查通过；规范JAR与Linux release实际重建 |
| Windows/Ubuntu 24.04×Node 22/24 增强安装四格 | 最终同组六包四格均完成imports/Java sources/native/CLI/MCP运行与独立consumer声明导入/Playwright示例类型编译；TS5.9.3/@typesNode20.19.41，strict NodeNext/skipLibCheck |
| Windows 完整 live | 最终独立 consumer 19 条定义：16 正常通过、1 预期失败取证、2 Linux 专用 skip；exit0，18.9 分钟，unexpected/flaky/retry=0。19 附件完整，测试 JVM 与全部根/嵌套 registry 已清理 |
| Ubuntu 24.04 真实游戏 | 最终四spec九项全部符合预期，exit0、11.3分钟、0retry；8正常pass+1预期失败取证、unexpected/skip=0。完整原始产物已回收，12附件missing0/5inline解码；同容器内16测试JVM全部消失、registry为空，自有live容器已停止且OOM=false |
| GitHub 实际运行与正式支持声明 | 未执行/未升级，继续保持候选身份 |

Windows结构化证据为`target/windows-qualified-install-summary.json`，记录当前sourceHash、verified/六包/日志哈希、运行与类型编译成功标记，以及显式JDK结果。原始日志为`windows-qualified-rust.log`、`windows-qualified-jdk.log`、`windows-qualified-native.log`、`windows-qualified-sdk-node-{22.14.0,24.20.0}.log`、`windows-qualified-release-node-{22.14.0,24.20.0}.log`、`windows-qualified-live-types.log`与`windows-qualified-install-node-{22.14.0,24.20.0}.log`；安装使用Node22/npm10.9.2和Node24/npm11.19.0。

Ubuntu 24.04 汇总为 `target/toolchains/ubuntu24/qualification-summary.json`；原始日志位于其 `remote-evidence/logs/qualified-{rust,agents,sdk,pack}.txt`、`qualified-sdk-node-{22.14.0,24.20.0}.txt` 和 `qualified-install-node-{22.14.0,24.20.0}.txt`。已独立统计 `remote-evidence/results-xml/qualified-project/` 的17份JUnit XML，共90条、1skip、0failure/error；Java/JDK验证使用进程级 `LANG/LC_ALL=C.UTF-8`。三个专属构建容器已停止，记录于 `qualified-cleanup-containers.txt`；exit137为主动停止闲置PID1，OOM=false，不代表停止仍在运行的独立游戏验收容器。

### 当前冻结产物与安装证据

最终 `release/verified.json` SHA-256 为 `c4ca2b043bbda20be4569a7c10f79d8d070817e41bb678e209056bdaf9f8dcf7`，版本 `0.1.0-alpha.1`，`verifiedOn=linux-x64`；它记录Ubuntu24规范组装步骤，Windows安装由独立日志证明。以下文件均已逐个重新计算SHA并核对manifest，Windows静态CRT和Linux tar0755检查通过。

| 当前7a原生产物 | SHA-256 |
| --- | --- |
| `native/win32-x64/blockwright.exe` | `6863da03515f21ed6b1fea5693236b5ef12e7f1596e235d9aeabef1994f9f129` |
| `native/linux-x64/blockwright` | `7afbf99eb3ab78c1345e469f02f7f484b546f595b44bfd8eb239092c659c2883` |
| `agents/blockwright-neoforge-agent-0.1.0-alpha.1.jar` | `4fbc0ed83c27ace62c6ce6a3bfaa8c304b6c5733e12f9e146375c3abc49590de` |
| `agents/blockwright-coverage-0.1.0-alpha.1.jar` | `d8909cdb3ed2722290705f6b422974db9e5625c8d230ef4d0af2c0bdd868285c` |

| 当前最终`0.1.0-alpha.1`归档 | SHA-256 |
| --- | --- |
| `izakyl-blockwright-client-0.1.0-alpha.1.tgz` | `721195a012cd1754c4185dccbbd20872eb333b41a79221c0f1e520cc55d01fde` |
| `izakyl-blockwright-ui-0.1.0-alpha.1.tgz` | `9f14b0b59fa769a86feb63373975122862e702a3467eb9755b55941f97510beb` |
| `izakyl-blockwright-minecraft-0.1.0-alpha.1.tgz` | `9462e9d9f0ec08bf096ce32b8a162805f07aa605d8d44f48c0e571616668e0d9` |
| `izakyl-blockwright-test-0.1.0-alpha.1.tgz` | `91c10fa7317a555bc74957823d25d0d1879f3c4cff27d4d48e0821e45faeeb7c` |
| `izakyl-blockwright-mcp-0.1.0-alpha.1.tgz` | `cd779e624f061623335654a36f1b9b0961b8f6d0df408216cbf9c0a216a4c8ea` |
| `izakyl-blockwright-cinema-0.1.0-alpha.1.tgz` | `d305864c798fc3e410ca1a7f43d84e2be9d194df0a6a0f3d003b07c5a1b43c63` |

最终Windows独立consumer首轮安装器未采用环境中的HTTP_PROXY，观察到直接连接远端443停在SynSent、下载缓慢；在游戏启动前按身份核对后主动终止该轮专属driver/installer/worker/runner，并仅为新测试进程设置现有本地代理的`JAVA_TOOL_OPTIONS`后重跑，未改全局代理。身份和原因保留于`target/windows-final-cold-direct-interrupted.json`。这是主动中断，不是测试断言失败；首轮原始log因相对cwd轮替错误被新运行覆盖，仅有工具中已观察的启动片段与上述metadata，不能宣称完整旧raw log已留存。新一轮19条定义使用同一冻结身份，最终结果如下。

### 当前 Windows 最终真实游戏证据

正式套件使用独立安装的最终六包，没有 CLI 或 coverage-tool override，也没有可被误选的 Gradle build 目录。实际服务端 mods 目录中的 agent SHA 与规范 Linux 构建的 `4fbc0e…` JAR 一致，见 `target/windows-final-observed-agent.json`。`target/windows-final-report.json` 与 `windows-final.log` 记录 exit0、18.9 分钟、17 expected/2 Linux-only skip；其中 16 项正常通过，1 项为 fixture 声明的预期失败取证，unexpected/flaky/retry 均为零。

`target/windows-final-evidence/validation-summary.json` 核验全部 19 个附件，解码 4 个内联附件，并记录所有根目录及中文路径下嵌套 registry 均为空。`target/windows-final-process-cleanup.json` 确认 16 个持久 trace 中的 JVM PID 已消失；额外窗口探针按 PID 与精确创建时间核验 39 个被跟踪 Java 身份均已消失。两组有重叠，不相加作为 JVM 总数。十轮每轮另断言 server/client PID 消失与 registry 删除，20 次实例关闭全部 success=true/killed=false。没有终止全局 Gradle 或不明 Java 进程。

最终 WGL 报告为 RTX 4070、OpenGL 3.2/NVIDIA 610.88、software=false/degraded=false，ready 时 visible=false/focused=false。最终 Windows MP4 为 H.264 854×480@10fps 与 AAC 48kHz 双声道，5 秒、blackFraction=0，解码 PCM audioRms=0.020182518223854484；原始流信息见 `target/windows-final-media-streams.json`。公开 `media.probeVideo` 同时使用含空格的 FFmpeg/ffprobe 绝对路径也通过，见 `target/windows-final-ffprobe-space-path.json`。真实 JVM fatal-error 附件 213,368 字节，包含 EXCEPTION_ACCESS_VIOLATION，code=1/killed=false/success=false；无响应超时则 code=1/killed=true/success=false，两种失败均正确保留证据。

有效窗口采样 v3 位于 `target/windows-sdk-probes/windows-final-window-monitor-v3/`：12 分 19.5 秒、2,557 次采样、4,654 个受管窗口观察，捕获 14 个真实 GLFW client，visible/foreground 均为零。十个 soak client 全部按 PID/创建身份匹配持久 trace，采样器在 spawn 前启动、exit 后仍运行；14 份匹配 trace 已独立归档。目标间隔 200ms，实际 median=214ms、p90=602ms、p99=801ms、max=1025ms，进程发现周期 1 秒。v3 开始晚于最初 coverage/lifecycle；此证据不能排除发现前或采样间隙的瞬时变化，不称为全套件逐帧监测。v1 未抓到真实 client，不能计入通过证据；历史 v1/v2 原始记录保留。

跨平台最终汇总为 `target/final-windows-qualification-summary.json`，包含冻结哈希、安装四格、两平台游戏结果、清理与未验收项目；可运行 `node target/record-final-qualification.mjs` 复算。GitHub 实际运行和真实 Windows 磁盘耗尽仍未验收，继续保持未发布候选状态。

### 当前 Ubuntu 24.04 最终真实游戏证据

最终同组六包在 Ubuntu 24.04.5 Docker userland 的四 spec 九项全部符合预期：8 正常 pass + 1 声明过的预期失败，unexpected/skip/retry 均为 0，耗时 11.3 分钟、exit0。游戏容器为普通 uid1000、4 CPU/8 GiB，JDK21.0.12.1、Node24.20.0、FFmpeg6.1.1；共享 Arch 宿主内核，此结果不等同于原生 Ubuntu 宿主或 GitHub workflow 已执行。

原始归档已完整复制并解压到 `target/remote-linux-live/ubuntu24-final/`。`final-ubuntu24-live-artifacts.tar.gz` SHA-256=`2233a691a589489eee9c314744f4038b1d322fa73d0f345234020fce3fac5852`，已独立计算匹配；`evidence/validation-summary.json` 记录逐项状态、冻结输入、16份trace、12个附件（missing=0）及5个已解码inline附件。完整原始 JSON、trace、PNG/MP4、coverage 与世界文件均保留，具体路径记录于该汇总与 `evidence/attachment-index.json`。

| 当前 Ubuntu 24.04 实机结果 | 原始证据与边界 |
| --- | --- |
| 原 Unix signal + 30秒默认宽限正常保存退出；无预跑snippet的pair服务端13.021秒退出，success=true/killed=false/code143/signal=null；修改diamond世界后重开验证通过，两次关闭5.467秒/1.146秒 | `evidence/validation-summary.json` 的trace时间与outcome；`consumer/test-results/live-signal-server.ndjson`、`linux-save-*-round-{0,1}.ndjson` |
| 实际EGL llvmpipe LLVM20.1.2、GL4.5core Mesa25.2.8；auto回退degraded=true，1190colors/mean119.7183/短采样35.6527fps；显式software degraded=false，1196colors/mean119.5562，fps=null无有效量测 | `evidence/decoded-attachments/003-offscreen-report.json`、`004-offscreen-software-report.json`；不宣称物理GPU通过或软件FPS已量测 |
| MP4为单H.264视频流，854×480@10fps、33帧/3.3秒，dropped/repeated/skipped/black秒均0；OpenAL记录48kHz/stereo/f32le设备格式 | `evidence/offscreen-ffprobe.json`、`003-offscreen-report.json`与MP4；没有MP4音轨或独立真实PCM RMS字段，不据设备信息宣称非静音音频通过 |
| coverage1608classes/312executed、4489/71910lines、32mixin类/80个mixin lines、3sessions/852dumped classes；HTML/XML/LCOV与fixture预期失败PNG/JSON/文本均保留 | `evidence/decoded-attachments/001-coverage-summary.txt`、`consumer/test-artifacts/final-ubuntu24/`、`evidence/decoded-attachments/005-failure-evidence.json`及附件索引 |
| 同容器内16个测试JVM全gone，remainingGames=0、registry=0；自有live容器已停止，OOM=false | `evidence/process-cleanup.json`、`container-state-after-stop.json`；独立build容器清理另见Ubuntu构建汇总 |

## 已测环境

| 项目 | 实际环境 |
| --- | --- |
| Windows | Windows 11 专业版，10.0.26300 / build 26300，x64，已登录交互式桌面 |
| GPU / 驱动 | NVIDIA GeForce RTX 4070；Windows 驱动 32.0.16.1088，OpenGL 报告 NVIDIA 610.88 |
| OpenGL | NVIDIA Corporation；NVIDIA GeForce RTX 4070/PCIe/SSE2；3.2.0 NVIDIA 610.88 |
| Java | OpenJDK 21.0.2+13-58，Java/Javac 21 |
| 游戏目标 | Minecraft 1.21.1，NeoForge 21.1.233 |
| Native 库 | LWJGL 3.3.3+5，GLFW 3.4.0 Win32/WGL，OpenAL Soft 1.23.1 |
| Node | Windows x64 的 22.14.0 和 24.20.0 |
| Rust | 固定 1.98.1；Windows MSVC target 与 Linux GNU target |
| Linux 回归 | WSL2 Ubuntu 22.04.5 LTS x86_64，内核 6.18.54.1-microsoft-standard-WSL2；并非 Ubuntu 24.04 发布基线 |
| Ubuntu 24.04 基线环境 | 远程 NVMe Linux 主机上的 Ubuntu 24.04.5 LTS amd64 Docker 容器；glibc 2.39-0ubuntu8.9、OpenSSL 3.0.13；安装/SDK 使用 Node 22.14.0/npm 10.9.2 与 Node 24.20.0/npm 12.0.2；容器共享宿主内核 |
| 远程 Linux 真实游戏 | Arch Linux x86_64、内核 7.2.9-zen1-1-zen、NVMe 独立运行目录；Temurin JDK 21.0.12.1+1、FFmpeg/FFprobe 9.0.2；游戏实际 EGL 4.6/Mesa 26.2.4/llvmpipe LLVM 23.1.1，auto 发生软件回退；不将独立探针枚举到的物理 GPU 当作游戏 GPU 验收，也不新增发行版支持承诺 |

GPU 结论限定于上述实测机器与驱动，不推广为所有显卡、无桌面会话或断开的 RDP 会话均已通过。

## 验证结果与证据

以下路径相对于仓库根目录。除另行注明的实验和当前状态外，本表是旧 `a4c251…` 候选的历史证据；`target/`、`.blockwright/`、`build/` 和 `release/` 下的原始证据属于本地忽略产物，交付或 CI 验收时应另行归档。

| 项目 | 已确认结果 | 证据 / 复跑入口 |
| --- | --- | --- |
| 独立图形探针 | 5 轮，每轮 120 帧；320×240 RGBA8 FBO 变化像素准确；每帧 Win32 检查窗口不可见且不是前台窗口；事件处理与销毁成功 | `scripts/probes/windows-display/build/environment.json`、`build/result.txt`；[探针说明](../scripts/probes/windows-display/README.md)、[run.ps1](../scripts/probes/windows-display/run.ps1) |
| 独立音频探针 | 48 kHz、stereo、float32；合成 440 Hz 音调 RMS = 0.20565464009301312；context/device 正常关闭 | 同一探针的 `build/result.txt`；8 个依赖 JAR 的 SHA-1 记录于 `build/environment.json` |
| 生产 agent GPU opt-in | `ClientOffscreenTest` 曾单独通过真实 WGL/FBO/release 与 `ClientAudio` 非静音 `Hooks.AUDIO_MIXED` 验证 | [探针说明中的 opt-in 命令](../scripts/probes/windows-display/README.md)；此结果与后续普通 clean build 的 GPU skip 分开看待 |
| Windows Rust | 110 个 library + 24 个 binary 测试通过，共 134 个 active、3 个 ignored，0 失败 | `cargo test --locked`；忽略项包括独立 JDK 资格测试和由其他测试调用的辅助进程入口 |
| Linux Rust | 105 个 library + 28 个 binary 测试通过，共 133 个 active、2 个 ignored，0 失败；最后的缺失/不匹配进程身份分支随后精确复测 5 通过、1 个辅助入口 ignored | `target/linux-validation/validation-summary.json`；`target/toolchains/linux/validate.sh` |
| Windows 文件系统 | 实际缓存/文件系统隔离 harness 19/19 通过；包含 readonly 硬链接保护、独立副本、并发放置、源 JAR 持续重写、失败替换与暂存回收；主 Rust 回归同时包含 store/GC/锁测试 | `target/storage-probe/`；源码测试位于 `store/`、`platform/fs.rs`、`engine/mod.rs` |
| Java clean build | 最新 XML：neoforge-agent 77 条，76 通过、1 个 GPU opt-in skip；coverage-report 13 条全部通过；合计 90 条，89 通过、1 skip、0 failures/errors | `neoforge-agent/build/test-results/test/TEST-*.xml`、`coverage-report/build/test-results/test/TEST-*.xml`；对应 clean build 及 JAR 构建已完成 |
| Java 路径解析 | 最新 `SnippetClasspathTest` 5/5 通过；覆盖 Windows 盘符、UNC、file/jar/union 包装、百分号编码、Unicode 与本机 URI 路径 | `neoforge-agent/build/test-results/test/TEST-dev.blockwright.agent.SnippetClasspathTest.xml` |
| Java argument files | 显式运行真实 JDK 21 测试通过；classpath 超过 32,767 字节，路径含中文/空格；空值、引号、尾反斜杠、换行/控制字符、字面 `#`/`@` 按 code point 往返一致 | `cargo test --lib java_argument_files_round_trip_long_classpaths_and_unicode_with_a_real_jdk -- --ignored --nocapture`；当前 Windows ANSI code page 为 CP936 |
| SDK / 两平台两 Node 版本 | Windows 与 Ubuntu 24.04 容器的两个 Node 版本均为 258/258 通过，0 skip、0 失败；各次六包测试数为 16+87+46+86+3+20；Windows ZIP seed 与 FFmpeg 媒体单元测试均已执行 | `.blockwright/final-sdk-node-v22.14.0-win-x64.log`、`.blockwright/final-sdk-node-v24.20.0-win-x64.log`；`target/toolchains/ubuntu24/remote-evidence/logs/sdk-node-{22.14.0,24.20.0}.txt` |
| 发布脚本 / live 类型检查 | Windows 与 Ubuntu 24.04 容器的两个 Node 版本均 9/9 release tests 通过；Ubuntu 24.04 的 live 类型检查通过，npm audit 本次报告 0 vulnerabilities；不代替 Rust/Java 重建或真实游戏 | `scripts/release.test.mjs`；`target/toolchains/ubuntu24/remote-evidence/logs/sdk.txt` 与 `sdk-node-{22.14.0,24.20.0}.txt` |
| Windows PE 依赖 | CRT 静态链接；导入表仅包含 Windows 系统 DLL，未要求额外 VC runtime DLL | `release/native/win32-x64/manifest.json` 的 `crt`、`runtimeDependencies` 与 `rustFlags` |
| 真实服务端 | 方块保存、关闭后重开仍可读取；正常 close 返回 success=true/killed=false；EOF 关闭后 PID 与 registry 清理；强杀驱动后 JVM 在 10 秒内消失 | [windows-support.spec.ts](../live/windows-support.spec.ts) 前三项；`target/windows-live.log`、`test-results/` 的保存关闭结果附件 |
| 真实客户端与媒体 | 基础 live 通过：客户端连入真实服务端，玩家/UI/拖动/推进 tick 与有效截图；视频可解码且 blackFraction<0.5；PCM 音频 RMS>0.0001 | `target/windows-live.log` 完整 5/5；[windows-support.spec.ts](../live/windows-support.spec.ts)、`test-results/` 的 PNG/MP4 与附件 |
| 自定义 FFmpeg / FFprobe 路径 | Windows Node 24.20.0 使用公开 `media.probeVideo`；两个工具均为 `target/encoder tools/*.exe` 含空格绝对路径；复用真实游戏录制的 425627 字节 MP4，duration=5.9s、blackFraction=0、blackCheck=ok；这是媒体补充验证，不增加 unique 游戏场景数 | `target/windows-ffprobe-space-path.mjs`、`target/windows-ffprobe-space-path.json`；MP4 SHA-256=`e2a4e996483d8e28d64ffec16d0e24b29d1d40c719afec094be43980c0b4e46a` |
| 中文路径 / MCP / snippet / cinema | 完整发布版 CRT-static driver 与共享 agents 在 CP936 中文空格目录 launch 成功；MCP server snippet 同时访问 agent API、Minecraft 类和玩家状态；四帧 cinema 视频非黑、含空格绝对 FFmpeg 路径可执行，正常 pair close 通过 | `target/windows-qualification.log`，强化资格完整 3/3；[windows-qualification.spec.ts](../live/windows-qualification.spec.ts)、`target/windows-qualification-results/` |
| 连续十轮 client/server | 10/10 轮完整 join、有效截图、client/server close 成功，killed=false、signal=null；每轮 PID 消失、registry 删除；20 份 trace 的关闭结果已提取并断言 | `target/windows-ten-round-evidence.json`、`target/windows-qualification.log`、[windows-qualification.spec.ts](../live/windows-qualification.spec.ts) |
| 真实窗口属性 | 发布版实际 context 报告 wgl/win32/software=false；游戏内调用 GLFW 验证 visible=false、focused=false；截图与 UI 仍可用 | `target/windows-qualification.log` 第三项；[windows-support.spec.ts](../live/windows-support.spec.ts) 的 nativeWindow 断言；该检查是游戏 ready 时的采样，独立 P0 探针另有逐帧检查 |
| 真实覆盖率 | 报告 1608 classes/312 executed；4539/71910 lines；32 个 mixin 类、19 个 source 实际运行、83/392 mixin lines；2 sessions、852 dumped classes；HTML/XML/LCOV 生成 | `target/windows-regression.log`；`target/windows-regression-results/coverage-a-game-with-cover-97090-od-s-classes-and-its-mixins/coverage/` |
| 扩展 Windows 回归 | coverage、同目录 busy 拒绝/游戏死亡、正常驱动关闭/驱动死亡、公共 offscreen 与基础五项全部通过；合计 9 passed/1 skipped，6.6 分钟；唯一 skip 是 Linux software 专用用例 | `target/windows-regression.log`、`target/windows-regression-report.json`、`target/windows-regression-results/`；录像 RMS、world close outcomes 与隐藏属性附件已持久化 |
| 真实故障资格 | 2/2 通过，36.3 秒；启动未 ready 时 EOF 取消，强杀失败可观察为 driver code=75，原 JVM/registry 消失后同目录重试成功；真实服务端主线程阻塞后以 grace=250ms close，返回 success=false/killed=true/signal=null，PID/registry 清理且失败实例目录保留 | `target/windows-failure.log`、`target/windows-failure-report.json`；`target/windows-failure-results/**/windows-startup-cancel.json`、`windows-timeout-close.json`；[windows-qualification.spec.ts](../live/windows-qualification.spec.ts) |
| 真实 JVM fatal-error | 1/1 通过，20.6 秒；一次性服务端 JVM 的 Unsafe 零地址写触发 EXCEPTION_ACCESS_VIOLATION；返回 code=1/terminated=false/killed=false/signal=null/success=false，并提供实际 `hs_err` 文件与含异常、problematic frame 的摘要；PID 消失且实例目录保留；测试用 `-XX:-CreateCoredumpOnCrash` 关闭 dump 生成 | `target/windows-jvm-fatal.log`、`target/windows-jvm-fatal-report.json`、`target/windows-jvm-fatal-results/**/windows-jvm-fatal-close.json`；207100 字节原始日志归档为该 case 的 `windows-jvm-fatal.log`，实例原文件位于 `live/.blockwright/.blockwright/instances/windows-fatal-1792083203978/hs_err_pid26440.log` |
| Windows fixture 失败证据 | 3/3 通过，1.5 分钟；真实 prefab handles 与失败步骤取证，后续测试确认 observation、diamond×7 容器、玩家实体、5 张 PNG 及文本/JSON 附件，正常清理；report 为 expected=3/unexpected=0，失败步骤是明确声明的预期失败 | `target/windows-fixture.log`、`target/windows-fixture-report.json`、`target/windows-fixture-results/`；[test-fixtures.spec.ts](../live/test-fixtures.spec.ts) |
| Linux 真实服务端 smoke | WSL Ubuntu 22.04、Node 24.20.0；冻结 20 tps，diamond block 写入后读回；close=code143/success=true/killed=false/signal=null，关闭后 PID 消失；原始 JSON 完好 | `target/linux-live/server-smoke-report.json`；独立服务端证据有效，不代表后续客户端套件通过 |
| WSL 客户端套件中断 | 运行时观察到 software 1 项与 fixture 3 项符合预期，主用例冷启动累计 15 分钟 setup 超时；随后 uptime 回退与 scratch 丢失，完整 suite 报告未回收，主用例暖启动未重跑；不能记为整套通过 | `target/linux-live/linux-live-summary.json`、`target/toolchains/linux/linux-live-scratch-state.json`；`target/linux-live/cold-attempt-watchdog-observed-excerpt.txt` 仅为已观察栈摘录，非完整原始 crash report |
| 远程 Arch Linux 初轮 | 四 spec/8 项中 7 expected、1 unexpected、0 skip；offscreen 2/2、coverage 1/1、fixture 3 expected（含预期失败）、lifecycle 1 pass/1 真失败。offscreen 两项均实际 llvmpipe，auto degraded=true；主帧1434colors、视频31帧/3.1秒/0黑秒/0 dropped；48kHz/stereo/f32设备没有独立RMS字段。全部原始report/trace/PNG/MP4/coverage/fixture附件已回收 | `target/remote-linux-live/validation-summary.json`、`live-artifacts-initial.tar.gz`、`consumer/reports/`、`consumer/test-results/`、`consumer/test-artifacts/`；保留完整失败，不宣称初轮全绿 |
| 历史 Ubuntu 24.04 环境初检 | WSL/PRoot guest先完成loader/version初检；随后真正Docker Ubuntu24.04.5/glibc2.39完成a4安装/SDK/发布脚本与live类型检查。该阶段尚未完成Rust/Java重建；当前7a已完成，见开头状态，GitHub仍未运行 | `target/toolchains/ubuntu24/remote-evidence/logs/ubuntu-preflight.txt`、`container-dependency-versions.txt`、`ubuntu-image.json`；image digest=`sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55` |
| 完整 bundle / 增强四格安装矩阵 | 双 native + 公共 agents 组装及 Windows Node 24 pack-check 通过；冻结六包在 Windows/Ubuntu 24.04 容器×Node 22.14.0/24.20.0 仓库外 `--ignore-scripts` 安装均通过。每格校验归档哈希、imports/Java sources/native version/driver ping/closeAsync/CLI/MCP 握手，并在 consumer 自己的 node_modules 用锁定 TypeScript 5.9.3/@types/node 20.19.41 编译声明导入与 Playwright 示例（strict、NodeNext、skipLibCheck）；不依赖仓库 node_modules，未改六个 tgz | `target/windows-final-install-types-summary.json`、`target/windows-final-install-types-node-{22.14.0,24.20.0}.log`；`target/toolchains/ubuntu24/remote-evidence/logs/install-matrix.txt`、`install-node-{22.14.0,24.20.0}.txt`；[install-check.mjs](../scripts/install-check.mjs)、`release/verified.json` |
| 额外 WSL 运行烟测 | 原 WSL Ubuntu 22.04 的 Node 22/24 同包 imports、Java sources、native driver/CLI/MCP 运行烟测通过，Linux native tar mode 为 0755；旧脚本没有 consumer 类型编译，不将它记为增强类型矩阵 | `target/toolchains/linux/install-node-22.14.0.log`、`target/toolchains/linux/install-node-24.20.0.log` |
| Linux JDK locale 条件 | 最小容器默认`C`时，显式>32K/Unicode JDK资格首次因中文native path变成`?`而失败；仅给测试进程设置`LANG/LC_ALL=C.UTF-8`后，当前7a显式资格1/1通过，未修改宿主全局locale或生产源码 | `target/toolchains/ubuntu24/remote-evidence/logs/rust-locale-c-failure.txt`与`qualified-rust.txt`；[进程级环境设置](environment.md) |
| CI | 普通双平台 native/Java/SDK/release 构建、唯一归档组装与 Node 安装矩阵已接入；GPU workflow 要求交互式 self-hosted runner 与显式 EULA 输入 | [.github/workflows/ci.yml](../.github/workflows/ci.yml)、[windows-live.yml](../.github/workflows/windows-live.yml)；本轮尚未在 GitHub 执行 |
| 候选文档一致性 | 已核对 Windows 安装/JDK 路径、device 限制、ACP/独立 store、MCP node.exe 启动、双 native/公共 agents 组装与 CI 说明；文档保留 candidate 身份，没有将本地测试写成 GitHub 已运行或正式支持矩阵已升级 | [README](../README.md)、[环境要求](environment.md)、[CONTRIBUTING](../CONTRIBUTING.md)、[发布流程](releasing.md)、[MCP README](../packages/blockwright-mcp/README.md) 及其余五包 README |

### WSL 中断与证据限制

WSL 首轮客户端套件的主用例在首次安装、资源下载与等待期间达到 15 分钟 setup 预算。观察到的服务端 watchdog 栈停在 `UnixFileDispatcherImpl.write0 → NbtIo.writeCompressed → saveDataTag`；同期间另有独立 WSL 命令返回 `ERROR_TIMEOUT`。自动 launch retry 复用了实例和 trace 路径，删除了原始 crash report 并截断 trace，留下的摘录不能替代完整报告。随后 `/proc/uptime` 从约 3280 秒回退至约 21 秒，临时 scratch 丢失，完整 suite 报告无法回收，主用例也没有完成暖启动复测。

这些是已观察现象，原因尚未确认；不能据此断言磁盘 I/O 是唯一根因，也不能宣称 Linux 全程无失败。`linux-live-scratch-state.json` 记录 scratchExists=false、processes=[]，没有执行证据回收或 scratch 清理脚本。专属代理 relay 已按进程身份核对后停止，自有 PID 26340 不存在，记录于 `target/toolchains/linux/proxy-relay-cleanup.json`；没有据此处理不明全局进程。原先已落盘的服务端 smoke、Rust 回归和同包安装日志仍独立有效。后续远程 NVMe Linux 与 Ubuntu 24.04 容器验证单独记录，不覆盖或抹去本轮 WSL 失败及证据缺口。

### Linux 关闭宽限复现与正式取舍

旧 `a4` 在真实 pair ready 后立即关闭时，服务端超过默认 10 秒被强杀、驱动返回 75。jcmd 确认服务器等待 `ChunkStorage.flushWorker` 的 future；后续原始采样同时显示 IOWorker 持续 `pwrite`、region 锁对象变化和写入量推进，不能把这个等待直接定性为 deadlock、Log4j 故障或特定磁盘故障。

临时 `7daa` RPC 方案加 45 秒宽限、原并发关闭、不预跑 snippet、不加启动 sleep 的独立实验，在 12.504 秒完成保存并正常退出；`write_bytes` 从 4,468,736 到 6,868,992 再到 17,657,856。证据为 `target/remote-linux-live/evidence/lifecycle-diagnostic-1792089262594/report.json` 及同目录原始线程/IO采样。更小的“原 Unix signal 路径，仅默认改 30 秒”独立实验通过三项 lifecycle（含原失败与修改世界后重开），2.1 分钟；证据为 `evidence/lifecycle-baseline-budget.log`、`lifecycle-baseline-budget-exit.json`，实验 sourceHash=`4d0d7eba16fd18f5bc07be9ad377e0e907375e7b7b32e60d8f4f7b565d6586a6`。它们是诊断实验，不是最终规范产物。

正式候选据此保留 Unix 原关闭机制，仅把默认宽限提高至 30 秒，并继续接受显式 `graceMs` 覆盖及驱动 60 秒总清理预算。Windows 仍走原有内部 shutdown RPC；Unix 服务端没有采用临时 RPC 扩展。最终 Windows/Ubuntu 24.04 和归档安装结果须对新 sourceHash 重新记录。

### 历史 a4 原生产物身份（已被新候选取代）

旧Linux与Windows原生manifest曾记录同一版本`0.1.0-alpha.1`、同一sourceHash，以下不再表示最终发布输入。历史内容可从`target/remote-linux/release.tar.gz`溯源；表中为当时相对路径，工作树`release/`已由当前7a产物替换：

```text
a4c251fda2cd2b21e3b0e47a3fcfddc7fa0f2240e40c8a9fd6fa2c8b0b359334
```

| 文件 | SHA-256 |
| --- | --- |
| `release/native/win32-x64/blockwright.exe` | `66279d393a33702f271b96a753e44ca15319dfb5d3f63f560fc9b158ac33a4b4` |
| `release/native/linux-x64/blockwright` | `65244c90ba7b3d0d712fe8c517a8e5776e6e2ad0f0a28693beb28977ac872bf2` |

旧公共agents、双native和六包曾通过历史四格；旧WSL两格另记运行烟测。旧`verified.json` SHA-256为`e8bde589097fac546a80df4f2e147e3f36d1a43b0172b676fa794c6520a36185`、verifiedOn=win32-x64，不能沿用为新候选证明；当前已重建并替换native/JAR/client/MCP/verified身份，见上方最终表。

以下是**历史a4六包**的SHA-256，曾逐个计算并核对旧`verified.json`，保留用于溯源；当前最终7a哈希已列于上方。

| `0.1.0-alpha.1` 归档 | SHA-256 |
| --- | --- |
| `izakyl-blockwright-client-0.1.0-alpha.1.tgz` | `9d0c6a749e9ba6e1950a205fef37dcda55b9476e91405c23cd430ccfd93f29fe` |
| `izakyl-blockwright-ui-0.1.0-alpha.1.tgz` | `9f14b0b59fa769a86feb63373975122862e702a3467eb9755b55941f97510beb` |
| `izakyl-blockwright-minecraft-0.1.0-alpha.1.tgz` | `9462e9d9f0ec08bf096ce32b8a162805f07aa605d8d44f48c0e571616668e0d9` |
| `izakyl-blockwright-test-0.1.0-alpha.1.tgz` | `91c10fa7317a555bc74957823d25d0d1879f3c4cff27d4d48e0821e45faeeb7c` |
| `izakyl-blockwright-mcp-0.1.0-alpha.1.tgz` | `e44cc68df56e1098c46264a3a9246d6dcdd11e40a721d675fa120b8866c92842` |
| `izakyl-blockwright-cinema-0.1.0-alpha.1.tgz` | `d305864c798fc3e410ca1a7f43d84e2be9d194df0a6a0f3d003b07c5a1b43c63` |

## 实现与实机证据边界

- Windows client 使用隐藏 Win32/WGL 后端；Linux Null/EGL 与退出补丁按后端隔离。真实 Minecraft 的输入、截图、视频、游戏音频以及 ready 时 GLFW 隐藏/焦点属性均已通过；没有把 ready 时采样描述为完整游戏生命周期逐帧监测。
- stdin EOF、控制 shutdown、等待正常退出、强杀失败结果及 Job 清理已接入。回归覆盖输入队列过载、stdout 背压、取消、超时、重复 close 和进程身份判断；真实 client/server 连续 10 轮、启动中取消后重试及阻塞主线程超时强杀均已通过。code=75 与 success=false 是故障的预期可观察结果，不按正常关闭处理。
- Windows 文件放置使用独立副本；readonly 替换/删除不解除共享文件的保护；runtime key 包含 OS/arch/schema。现有测试未等同于真实磁盘耗尽、所有文件系统或 Windows/WSL 共用目录的验收。
- Java/native metadata、classpath separator、argument file 和 URI 解析已实现。中文空格目录中的 MCP server snippet、四帧 cinema、含空格 FFmpeg 绝对路径、十轮启停与隐藏属性强化资格已通过。
- 当前7a双native、规范公共JAR和六包已实际重建并冻结，同组六包Windows/Ubuntu24增强四格通过，包含独立consumer类型编译；Ubuntu24 Rust/Java/JDK资格及两平台最终真实游戏均符合预期。旧WSL/Arch失败和实验原始记录继续保留，GitHub与真实Windows磁盘耗尽仍未验收。

## 明确限制

Java 21 的 Windows launcher 按系统 ANSI code page 读取 argument files。本机 CP936 的中文路径已经通过；实现先按该 code page 编码，再转义参数，无法表示的字符会明确报错。`-Dfile.encoding=UTF-8` 或 `-Dsun.jnu.encoding=UTF-8` 不能修复 launcher 的解码方式，不能宣称任意 locale 下任意 Unicode 字符均已支持。

首版仍不承诺 Windows ARM64、无桌面/服务会话、RDP 断开后的图形、software/index 渲染、指定物理 GPU、UNC 上运行真实游戏、显式`\\?\`游戏根、所有超MAX_PATH路径或Windows/WSL共用运行目录。请使用常规`C:/...`盘符绝对路径。普通Java clean build中跳过GPU opt-in是预期行为；GitHub托管runner编译通过也不能替代GPU桌面实测。

### 当前 7a 独立锁与路径边界探针

最终Windows driver/SDK与Java21.0.2/ACP936的补充探针位于`target/windows-sdk-probes/lock-and-paths-1792091216415/`。`instance-lock-summary.json`确认三个独立driver对同一实例的争用、同名/大小写和配置前缀别名拒绝，以及owner释放后重新获得锁；所有自有driver/阻塞installer已退出。此处使用installer fixture，没有把锁探针称为启动真实Minecraft。

`path-prefix-matrix/summary.json`及`commands.ndjson`记录八项Java对照：普通classpath搭配显式`\\?\`输入/证据文件与显式前缀`@argfile`成功；显式前缀JAR/目录classpath、`-jar`及argfile中的前缀classpath失败。正常`read_document/resolve_path`只absolute/join；三处内部canonicalize用于cache源身份、same_file与Win32替换目标，不把这些扩展前缀注入常规JVM参数。检查已明确首版边界，不能解释为所有前缀用法通过。父目录原组合`summary.json`的passed=false保留，其失败来自后半段classpath前缀实验，不否定已完成的独立锁断言，也不能被引用为整组通过。

## 交付条件跟踪

- [x] 真实 Windows 客户端连接真实服务端，完成玩家状态、冻结/推进 tick、UI 点击/拖动与非黑屏截图验证。（基础 live。）
- [x] 录像可解码且非全黑，真实游戏音频非静音；FFmpeg 与 FFprobe 均可使用含空格绝对路径。（基础 live、强化资格与公开 media.probeVideo 补充验证。）
- [x] MCP、真实游戏 snippet、基础 cinema、故障关闭结果与客户端正常退出通过。（中文目录强化资格、启动取消/超时 close 及真实 JVM fatal-error 的 JSON 已归档。）
- [x] client/server 连续 10 次完整 join、有效截图和正常关闭；每轮无残留 JVM/PID/registry；另通过启动中取消后重试、真实主线程阻塞超时强杀与失败目录保留。
- [x] 含空格与当前 code page 可表示中文的路径完成真实游戏、snippet、证据与编码器全流程。（完整发布 bundle、CP936。）
- [x] 当前7a规范公共agents与两个native匹配sourceHash，完整bundle通过缺目标、陈旧及篡改拒绝检查；最终SHA已核验。
- [x] 当前最终六包在Windows/Ubuntu24×Node22.14.0/24.20.0仓库外`--ignore-scripts`安装，完成运行/独立类型编译及哈希核验。（新四格日志；不沿用a4结果。）
- [x] 当前Ubuntu24完成Rust133active/2ignored、显式JDK1/1、Java89pass/1opt-in skip、两Node SDK各258与release各9、live类型检查及规范构建。
- [x] 当前最终Ubuntu24四spec九项真实游戏场景全部符合预期，exit0、11.3分钟、0retry；完整原始产物和清理证据已归档、哈希核验，16JVM全gone/registry0。（8正常pass+1预期失败，不抹去旧WSL/Arch失败。）
- [x] 当前最终Windows独立consumer完成19条定义：16正常通过+1预期失败取证+2Linux skip，exit0/18.9分钟；19附件完整，测试进程与全部registry清理已核验。
- [x] Windows 世界、日志和真实覆盖率落盘；截图、录像、音频和 JVM fatal-error/进程残留结果归档。（当前 `hs_err_pid19860.log` 原文及213,368字节附件可读，崩溃摘要准确，PID消失，失败实例目录保留。）
- [x] Windows 候选安装、Java 路径/device 限制、MCP 主机启动、构建组装与 workflow 说明已更新并核对。（候选文档完成，不代表正式支持矩阵已升级。）
- [ ] GitHub workflow 实际执行结果、最终正式支持矩阵、CHANGELOG 与 `verified.json` 一致；完成前保持候选状态。
