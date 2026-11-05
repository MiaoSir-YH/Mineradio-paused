# 全仓审查问题修复与通用媒体接口

本次仅修改 Mineradio，未修改 BrimDeck。修复完成后按用户后续指示准备 v2.2.2 预发布验证版，通过 GitHub Windows 构建流程生成安装包。内存专项按用户指示停止。

## 通用媒体接口

新增 `public/js/modules/05-playback/14a-system-media-session.js`，使用标准 `navigator.mediaSession`。Electron 在 Windows 上负责把该接口连接至系统媒体会话；通用控制器可读取曲名、歌手、专辑、封面、播放状态和有效时间线，并发送播放、暂停、上下首和进度指令。

接口复用播放器控制入口，明确区分播放和暂停；只发布当前歌曲所拥有的音频状态。处理本地和在线歌曲、音频图恢复、已在播放的无缝交接、重复指令、封面变更、无效时长、旧音频事件及清空待播队列。音频图替换保留播放标识；启动尚未完成时的主动暂停会阻止后续启动流程恢复播放，也不会被误判为音源故障而换源或跳歌。取消暂停渐变会结束等待，避免遗留未完成的控制操作。

标准 Media Session **没有歌词传输字段**。BrimDeck 的普通播放器路径根据曲名、歌手在线查词，再用系统时间线同步；本次为这条路径补齐必要信息。不会把 Mineradio 伪装为官方 QQMusic 进程，也没有向 BrimDeck 注入私有歌词。词库缺失、版本匹配失败等情况仍可能没有歌词；Mineradio 的原词、翻译、自定义词和逐字信息不通过该标准接口传送。

## 原审查确认的 18 项问题

| 编号 | 修复结果 | 主要代码 |
| --- | --- | --- |
| 1 | 歌单首批请求绑定队列意图；晚返回的旧请求不能覆盖新队列或抢播。播客入口共享该规则。 | `06-lyrics/03-podcast-playlist-loaders.js` |
| 2 | 换源面板绑定队列、歌曲、索引和播放标识；切歌关闭面板，旧匹配及过期回滚不能修改新歌曲。 | `05-playback/07-search.js`、`13-playback-start-audio.js` |
| 3 | 队尾等待分页的外层回调验证原队列、分页状态、索引和播放标识。 | `05-playback/14-player-controls.js` |
| 4 | QQ HTTP 公共请求处理响应断流、错误和提前关闭，统一结束请求，并执行整个请求的总超时。 | `server.js` |
| 5 | 安装路径和归属检查的嵌套 NSIS 函数保存并恢复临时寄存器，保留合法旧安装路径。 | `build/installer.nsh` |
| 6 | 重启使用 `app.relaunch()` 加正常 `app.quit()`，进入现有有界清理流程。 | `desktop/main.js` |
| 7 | 内测包补齐汽水二维码登录、认证模块及认证资源。 | `electron-builder.internal-beta.json` |
| 8 | 关闭登录窗口或认证抽屉时作废创建请求和二维码 key，晚返回的二维码不能重启隐藏轮询。 | `08-account/03-login-modal-flows.js` |
| 9 | 每次摄像头启动拥有独立 Camera、Hands、video；旧操作只释放自己的资源和回调。 | `10-shell/00-gesture-control.js` |
| 10 | 动态脚本加载共享进行中的 Promise，失败移除节点与缓存，允许重新加载。 | `09-idle-toast-libraries.js` |
| 11 | 书架封面回调读取卡片当前绑定项目，已移除卡片不再重绘。 | `04-shelf/01-manager-core.js` |
| 12 | 同一本地背景视频复用 object URL；裁切、缩放不再重建 URL 或重载视频。 | `07-fx/02-accent-background-controls.js` |
| 13 | 背景裁切使用已有数值规范化逻辑，保留合法的 0%。 | 同上 |
| 14 | 汽水目标音质传入全部选流入口；在账号权限内优先完整音频，再按偏好选择或降级。 | `qishui-api.js` |
| 15 | 汽水缓存加入失效代际与 Promise 身份校验，清缓存后旧请求不能回填或删除新请求。 | 同上 |
| 16 | 解密音频正确处理 suffix Range、开放末尾、边界截断及不可满足范围。 | `server.js` |
| 17 | 桌面歌词子进程及窗口回调验证实例身份，旧实例退出不清空新实例引用。 | `desktop/main.js` |
| 18 | 构建生成带 appId 的 UTF-16 安装文件清单；卸载按清单删除文件和空目录，验证路径与 reparse point，保留未列出的文件。包含构建工具稍后加入的 `resources/elevate.exe`。 | `build/install-manifest.js`、`uninstall-manifest.nsh`、`after-pack.js`、`installer.nsh` |

旧包没有安装清单时仍使用保守清理，避免将未知文件当作程序文件删除。新包支持清单清理；用户额外存入安装目录的文件会保留。

## 依赖与测试

定向更新 Axios、body-parser、music-metadata、follow-redirects、basic-ftp、ip-address、node-forge、proxy-addr、qs 及锁文件。保留网易云 SDK 主版本，没有按 audit 建议降级 SDK。2026-11-05 的 `npm audit --omit=dev --json`：0 项漏洞。该结果表示当前生产依赖公告匹配已清零，不表示对所有上游代码完成了安全证明。

验证结果：

- `node --test tests/*.test.js`：230 项通过，0 失败、0 跳过。新增队列意图、异步生命周期、后端契约、桌面生命周期、安装清单与系统媒体接口回归；同步修正已移除入口、配置条件、重构资源所有权和升级依赖对应的旧断言。
- `node tests/system-media-session-electron-smoke.js`：完整页面加载真实 Electron 42.4.1 Media Session，使用合成本地 WAV 跑通封面、播放/暂停、重复指令、上下首和 seek，页面错误及测试日志均为空。此项禁用 Electron 开发模式的安全警告扫描器，避开其相对 ResourceTiming URL 解析异常；应用的页面错误和未处理 Promise 仍捕获并使测试失败。
- 正式及内测 Windows NSIS 包均在本地构建成功，显式 `--publish never`。构建复用已有 Electron 42.4.1 Windows 运行时；安装清单覆盖最终实际随包文件，无遗漏。
- 两份实际打包内容在 Electron 中启动后端成功，验证首页、媒体模块、汽水、QQ 与网易登录状态共 5 个 HTTP 入口；两份包中的本次变更源文件与工作区一致。
- NSIS 安装路径、栈/寄存器和卸载边界通过真实源函数的符号执行回归；NSIS 安装/卸载脚本已编译通过。`git diff --check` 通过。

当前环境为 Linux；以上不等于已执行 Windows 安装升级、卸载或 BrimDeck 实机联调。Windows 验收应同时检查系统媒体卡片与 BrimDeck 的 Mineradio 会话，逐项确认封面、播放/暂停、上下首、进度和在线歌词匹配。QQ 会员、真实摄像头及各在线平台仍受账号、硬件和上游服务状态影响。
