# safe db 手动发布 GitHub Release

本文说明如何在 macOS、Windows 和 Linux 上分别打包当前 Electron 项目，并将安装包手动上传到 GitHub Release。本文只介绍手动发布，不使用 GitHub Actions。

## 当前项目状态

当前项目使用 `electron-vite`，`npm run build` 只会生成 `out/` 中的应用代码，不会生成可供用户下载安装的 `.dmg`、`.exe`、`.AppImage` 或 `.deb` 文件。

要生成安装包，需要先引入 `electron-builder`。项目当前文档建议使用 Node.js 20，因此本文使用仍兼容 Node.js 20 的 `electron-builder 26`。如果以后将项目最低 Node.js 版本升级到 22.12 或更高，可以再评估升级 `electron-builder 27`。

## 计划发布的文件

建议第一版至少提供以下文件：

| 平台 | 架构 | Release 文件 |
| --- | --- | --- |
| macOS | Apple Silicon | `safe-db-0.1.0-mac-arm64.dmg` |
| macOS | Intel | `safe-db-0.1.0-mac-x64.dmg` |
| Windows | x64 | `safe-db-0.1.0-win-x64.exe` |
| Linux | x64 | `safe-db-0.1.0-linux-x64.AppImage` |
| Linux | x64 | `safe-db-0.1.0-linux-x64.deb` |

项目包含 `better-sqlite3` 原生模块。正式发布时，建议在对应操作系统和 CPU 架构的机器上构建对应安装包，不要在一台机器上强行交叉构建所有平台。

## 一次性准备

### 1. 安装 electron-builder

在项目根目录执行：

```bash
npm install --save-dev electron-builder@26
```

该命令会更新 `package.json` 和 `package-lock.json`，这两个文件需要提交到仓库。

### 2. 创建 electron-builder.yml

先在 `package.json` 顶层补充发布者和项目主页信息；其中邮箱必须替换成维护者的真实联系邮箱，否则 Linux `.deb` 打包可能缺少必需的维护者信息：

```json
{
  "author": {
    "name": "qq1060656096",
    "email": "<维护者邮箱>"
  },
  "homepage": "https://github.com/qq1060656096/safe-db"
}
```

以上字段与已有的 `name`、`productName`、`version` 等字段同级，不要把它们放进 `scripts`。

在项目根目录创建 `electron-builder.yml`：

```yaml
appId: io.github.qq1060656096.safedb
productName: safe db

directories:
  output: release

files:
  - out/**/*

asar: true
asarUnpack:
  - node_modules/better-sqlite3/**/*

npmRebuild: true
artifactName: safe-db-${version}-${os}-${arch}.${ext}

mac:
  category: public.app-category.developer-tools
  target:
    - dmg

win:
  target:
    - nsis

linux:
  category: Development
  target:
    - AppImage
    - deb
```

说明：

- `out/` 是当前 `electron-vite` 的构建输出目录。
- `release/` 用于保存最终安装包。
- `npmRebuild: true` 会在打包过程中为 Electron 重建 `better-sqlite3` 等原生依赖。
- `asarUnpack` 确保 `better-sqlite3` 的原生文件不会被封入无法直接加载的位置。
- `${version}` 取自 `package.json` 的 `version`。
- `${os}` 会生成 `mac`、`win` 或 `linux`，`${arch}` 会生成 `x64` 或 `arm64`。
- `appId` 在首次正式发布前应确定下来，后续版本不要随意修改。

### 3. 忽略本地安装包输出

在 `.gitignore` 中增加：

```gitignore
release/
```

安装包应通过 GitHub Release 分发，不要提交进 Git 仓库。

### 4. 可选：配置应用图标

如需自定义应用图标，可随后增加以下文件和配置：

```text
build/icon.icns    # macOS
build/icon.ico     # Windows
build/icon.png     # Linux，建议 512x512
```

```yaml
mac:
  icon: build/icon.icns
win:
  icon: build/icon.ico
linux:
  icon: build/icon.png
```

没有准备图标时先不要填写 `icon`，否则打包会因为找不到文件而失败。

## 每次发布前的准备

以下示例发布 `v0.1.0`。

### 1. 更新版本号

确认 `package.json` 中的版本为：

```json
{
  "version": "0.1.0"
}
```

Release 标签应与它保持一致：

```text
package.json version: 0.1.0
Git 标签:             v0.1.0
```

### 2. 提交发布代码

确认需要发布的代码、`package.json`、`package-lock.json` 和 `electron-builder.yml` 已提交，并且工作区中没有误带入发布的临时修改。

### 3. 执行基础检查

```bash
npm ci
npm run typecheck
npm run build
```

`npm run build` 成功后，应能看到：

```text
out/main/index.js
out/preload/index.js
out/renderer/index.html
```

## 在各平台构建安装包

每台构建机器都应先拉取同一个发布提交，然后执行：

```bash
npm ci
npm run typecheck
npm run build
```

### macOS Apple Silicon

在 Apple Silicon Mac 上执行：

```bash
npx electron-builder --mac dmg --arm64 --publish never
```

预期产物：

```text
release/safe-db-0.1.0-mac-arm64.dmg
```

### macOS Intel

在 Intel Mac 上执行：

```bash
npx electron-builder --mac dmg --x64 --publish never
```

预期产物：

```text
release/safe-db-0.1.0-mac-x64.dmg
```

### Windows x64

在 64 位 Windows 10 或 Windows 11 上执行：

```powershell
npx electron-builder --win nsis --x64 --publish never
```

预期产物：

```text
release/safe-db-0.1.0-win-x64.exe
```

### Linux x64

在 x64 Linux 上执行：

```bash
npx electron-builder --linux AppImage deb --x64 --publish never
```

预期产物：

```text
release/safe-db-0.1.0-linux-x64.AppImage
release/safe-db-0.1.0-linux-x64.deb
```

如需发布 Linux ARM64，请在 ARM64 Linux 上执行：

```bash
npx electron-builder --linux AppImage deb --arm64 --publish never
```

## 安装包验证

不要只确认文件已经生成。每个平台至少完成以下检查：

1. 在一台未运行开发环境的机器上安装或启动安装包。
2. 确认主窗口、Preload 和 Renderer 能正常加载。
3. 新建一个 SQLite 连接，确认 `better-sqlite3` 能正常加载。
4. 至少连接一种 TCP 数据库，确认数据库驱动可以工作。
5. 确认关闭并重新打开应用后，本地配置仍能读取。
6. 确认应用内显示的版本与本次 Release 版本一致。

`release/` 中还可能出现 `mac-arm64/`、`win-unpacked/`、`linux-unpacked/`、`builder-debug.yml` 等中间文件或目录。这些内容用于本地调试，不要上传到 GitHub Release。

## 汇总待上传文件

将各台机器生成并验证过的安装包集中到一个目录，最终目录建议只包含：

```text
safe-db-0.1.0-mac-arm64.dmg
safe-db-0.1.0-mac-x64.dmg
safe-db-0.1.0-win-x64.exe
safe-db-0.1.0-linux-x64.AppImage
safe-db-0.1.0-linux-x64.deb
```

检查以下事项：

- 所有文件都来自同一个 Git 提交。
- 所有文件名中的版本号一致。
- 同一个文件没有经过聊天工具或网盘的二次压缩、重命名或转换。
- 没有上传 `*-unpacked` 目录或调试文件。

## 创建并推送 Git 标签

确认当前提交就是本次要发布的提交，然后执行：

```bash
git tag -a v0.1.0 -m "safe db v0.1.0"
git push origin v0.1.0
```

如果远端已经存在该标签，不要重复创建或强制覆盖；先确认该标签是否确实指向本次发布提交。

## 在 GitHub 网页手动上传

1. 打开项目的 GitHub 仓库首页。
2. 点击右侧的 **Releases**。
3. 点击 **Draft a new release**。
4. 在 **Choose a tag** 中选择刚推送的 `v0.1.0`。
5. Release title 填写 `safe db v0.1.0`。
6. 填写更新说明，或者使用 GitHub 的自动生成 Release Notes 功能。
7. 将汇总好的 `.dmg`、`.exe`、`.AppImage` 和 `.deb` 文件拖入附件区域。
8. 等待所有文件上传完成，逐一核对文件名和大小。
9. 先保存为 Draft；确认所有平台文件齐全后，再点击 **Publish release**。

发布后，GitHub 会自动显示 Release Assets 下载列表，并另外提供：

```text
Source code (zip)
Source code (tar.gz)
```

这两个源码压缩包由 GitHub 自动生成，不需要本地上传。

## 发布后的检查

发布完成后再次检查：

- Release 标签和标题正确。
- Assets 中包含所有计划支持的平台和架构。
- 每个下载链接都能正常下载。
- 下载后的文件大小与本地文件一致。
- 至少重新下载并安装一个文件，排除上传损坏。
- README 或项目主页中的下载地址已指向最新 Release。

## 签名提醒

未签名的安装包可以用于内部测试，但公开发布时会遇到系统安全提示：

- macOS 可能被 Gatekeeper 拦截。正式发布应配置 Apple Developer ID 签名和 notarization；macOS 签名只能在 macOS 上完成。
- Windows 未签名安装包可能触发 SmartScreen 警告。正式发布应配置 Authenticode 代码签名证书。
- 签名凭据不要写入仓库、`electron-builder.yml` 或 Release 附件。

签名不影响“手动上传”的流程，只影响构建出来的安装包是否被操作系统信任。

## 常见问题

### npm run build 成功，但没有安装包

这是正常现象。`npm run build` 当前只执行 `electron-vite build`。必须继续运行对应平台的 `npx electron-builder ...` 命令。

### 打包后启动时报 better-sqlite3 ABI 错误

确认是在目标平台和目标架构上执行了完整的 `npm ci`、`npm run build` 和 `electron-builder` 命令，不要复制另一平台生成的 `node_modules`。`electron-builder.yml` 中应保留 `npmRebuild: true`。

### 可以在 macOS 上一次打出 Windows、Linux 和 macOS 吗

不建议当前项目这样做。项目包含原生依赖，不同平台需要不同的本机二进制；macOS 的正式签名也必须在 macOS 上完成。手动发布时分别在目标平台构建最稳妥。

### GitHub Release 中应该上传哪些文件

直接下载使用时只上传安装包：`.dmg`、`.exe`、`.AppImage`、`.deb`。不要上传 `out/`、`node_modules/`、`*-unpacked/` 或整个 `release/` 目录。

如果以后加入 `electron-updater`，还需要上传 `latest.yml`、`latest-mac.yml`、`.blockmap` 等更新元数据；当前手动下载场景不需要这些文件。

## 参考资料

- [electron-builder 文档](https://www.electron.build/v26/)
- [electron-builder 多平台构建说明](https://www.electron.build/v26/docs/multi-platform-build/)
- [GitHub：管理 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
