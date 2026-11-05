# Mineradio 2.2.1

Windows x64 安装包：`Mineradio-2.2.1-Setup.exe`。

- 按登录面板左侧从上到下的顺序尝试播放音源，不再始终优先使用歌曲原平台。
- 普通切歌、无缝切歌与 AutoMix 使用同一音源顺序；拖动平台排序后，后续切歌采用新顺序。
- 当前平台没有匹配、没有可播地址或音频启动失败时，继续尝试下一个可用平台。
- 保留平台登录、播放授权与会员权益检查，以及本地音乐、播客和当前歌曲手动换源功能。

本次安装包从当前源码完整构建，保留正式版应用标识，可用于更新现有安装。
安装包从 [v2.2.1 GitHub Release](https://github.com/MiaoSir-YH/Mineradio-paused/releases/tag/v2.2.1)
附件直接下载，历史网盘内容未更新。

构建命令：Windows 使用 `npm run build:win -- --x64 --publish never`；
Linux（已安装 Wine）使用 `npm run build:win:linux`，通过 electron-builder
内置提取器生成卸载程序，兼容未提供 32 位 WoW64 的 Wine 环境。
