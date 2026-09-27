# AGENTS.md

给在本仓库工作的 AI 代理与协作者的项目约定。

## 分支模型：dev 开发，master 发布

- 日常开发在 **`dev` 分支**进行，推送即触发 CI 构建并发 **dev 预发布**：tag 为
  `v<base>-ci.<构建号>.g<sha>`，版本号在 CI 里被改写为 `<base>-ci.<构建号>.g<sha>`。
  tag 必须是合法 semver 且预发布段匹配通道——electron-updater 按 tag 的 semver 通道匹配
  release，`ci-<sha>` 这类 tag 它永远找不到；构建号保证版本严格递增，不要改回只用 sha。
- 装了 dev 版（版本号带 `-ci.`）的应用会通过 `ci.yml` 通道**自动跟随 dev 提交更新**；
  装稳定版的只读 `latest.yml`，永远看不到预发布。两条通道互不干扰。
- dev 预发布只保留最新 **3 个**（每个约 130 MB，CI 自动裁剪）。
- 功能验证没问题后，把 dev **merge 回 `master`**。master 的普通推送同样只发 dev 预发布；
  要发稳定版：
  1. 升 `package.json` 版本号（如 `npm version 0.1.5 --no-git-tag-version`）；
  2. `CHANGELOG.md` 的「未发布」小节改为对应版本号；
  3. 在 master 上打 **`v*` 标签**（必须与 package.json 版本一致，否则构建直接失败）并推送标签，
     CI 会构建安装包并发布带 `latest.yml` 的稳定 Release。

## 推送方式：git push 被代理阻断，走 API

本机代理会掐断 `git-receive-pack` 的 POST（TLS/SSL_ERROR_SYSCALL），`git push` 和 `git fetch`
都会失败；`api.github.com` 直连可用。因此：

- 推提交：`scripts/publish-via-api.mjs`，从 Git Data API 重建提交（blobs → tree → commit → ref）。
  Token 从本机凭据管理器取：
  `printf "protocol=https\nhost=github.com\n\n" | git credential fill` 的 `password=` 字段。
- **推完后本地分支不会自动前进**：用 API 元数据（tree / 父提交 / 消息 / 时间戳，时区 **+0800**）
  `git commit-tree` 重建同 sha 提交对象，再 `git update-ref` 对齐 `master` 与 `origin/master`。
- 新建远端分支：`POST /repos/kangnn/LeagueHextech/git/refs`（脚本只支持更新已存在的 ref）。

## 提交前验证

- `npm test`（纯 Node，无需 Electron/客户端）必须全过。
- 改了 `.github/workflows/*.yml` 后：用 `js-yaml` 本地解析一遍确认无缩进错误；
  涉及构建/发布产物的改动（如 electron-builder 产物文件名、更新通道文件）要**先在本地
  跑一遍 `npm run build:installer` 验证产物**再推送。
- 注意：electron-builder 无论版本是否为预发布，都只写 `latest.yml`——dev 通道的 `ci.yml`
  是发布时拷贝生成的，不是构建器自动生成的。

## 参考资料

- LCU 接口与 DTO 文档（社区维护的完整 schema）：https://www.mingweisamuel.com/lcu-schema/
  （本机国服客户端不暴露 swagger，查字段名以该文档 + 真实报文为准。）
- GitHub 上仓库：https://github.com/kangnn/LeagueHextech
