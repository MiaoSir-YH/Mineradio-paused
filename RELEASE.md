# Mineradio fork 构建与发布

## main 自动构建

推送到 `main` 会触发 `.github/workflows/release-windows.yml`，检出该次推送的提交，使用锁定依赖运行完整回归与原生 Electron 检查，再构建 Windows x64 NSIS 安装包。

构建会核对包内版本、源码、安装文件清单及应用启动状态，并保存安装包、SHA-256 和构建记录。产物保存在对应 GitHub Actions 运行中；`main` 构建不会创建、发布或覆盖 Release。

## 手动发布

工作流的 `workflow_dispatch` 保留显式标签发布流程。标签必须对应已有草稿 Release，版本必须与 `package.json` 一致。工作流检出指定标签，完成同样的构建检查后，才向草稿上传产物；上传前再次确认 Release 仍是草稿。

正式版本额外生成只含 `version` 与 UTC `releaseDate` 的 `latest.yml`，预发布版本不生成此文件。客户端仅从当前仓库 `MiaoSir-YH/Mineradio-paused` 检测正式版本并跳转到该版本的发布页；赞助渠道与原项目网盘入口已移除。

## 本地验证

```powershell
npm ci
node --test --test-reporter=tap tests/*.test.js
node tests/system-media-session-electron-smoke.js
npm run build:win -- --x64 --publish never
```

版本号以 `package.json` 为准。构建使用当前源码，不复用旧安装包；正式版和内测版产物分别验收。
