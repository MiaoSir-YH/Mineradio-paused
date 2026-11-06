# Fork 更新行为

本 fork 使用当前仓库 `MiaoSir-YH/Mineradio-paused` 的 GitHub Releases 检测正式更新，版本高于本地时显示更新提示，并通过系统浏览器打开当前仓库对应的版本发布页。原项目的更新源、赞助入口及旧网盘地址已移除。

`main` 每次推送的构建产物保存在对应 GitHub Actions 运行中，不会自动发布到历史 Release。构建和显式标签发布流程见 [RELEASE.md](../RELEASE.md)。

手动发布正式版本时，工作流生成的 `latest.yml` 只包含版本号和 UTC 发布时间。该文件不含安装包地址，用于 GitHub API 暂时不可用时的备用版本检测。Actions 构建产物和草稿 Release 不会被作为正式更新推送给客户端。
