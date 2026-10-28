# 安装与升级

`web` 是一个单文件二进制，内嵌 Bun 运行时，不需要预先安装任何运行时。

## 一键安装（macOS / Linux）

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh | bash
```

脚本会：

1. 识别操作系统和 CPU 架构（darwin / linux × x64 / arm64）；
2. 从 GitHub Releases 下载最新版本的 `web-<os>-<arch>`；
3. 用 `SHA256SUMS` 校验（Release 未提供时只警告）；
4. 安装到 `~/.local/bin/web`（如果目录不在 `PATH` 中会提示）；
5. 自动安装 agent skill 到 `~/.claude/skills/web-cli/`。

选项：

```bash
./install.sh --version v0.1.0      # 安装指定版本
./install.sh --dir /usr/local/bin  # 换安装目录（需要写权限）
./install.sh --no-skill            # 不安装 agent skill
./install.sh --force               # 覆盖本地修改过的 SKILL.md
```

环境变量：`WEB_REPO`、`WEB_VERSION`、`WEB_INSTALL_DIR`、`WEB_BASE_URL`（镜像或本地测试用）。

不想“下载即执行”的话，先保存再运行：

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh -o /tmp/web-install.sh
bash /tmp/web-install.sh
```

## 手动下载

从 [Releases](https://github.com/Eivs/agent-web-cli/releases) 下载对应文件：

| 平台 | 文件 |
|---|---|
| macOS Apple Silicon | `web-darwin-arm64` |
| macOS Intel | `web-darwin-x64` |
| Linux x86_64 | `web-linux-x64` |
| Linux arm64 | `web-linux-arm64` |
| Windows x86_64 | `web-windows-x64.exe` |

```bash
chmod +x web-darwin-arm64
mv web-darwin-arm64 ~/.local/bin/web
web --version
```

## 从源码构建

需要 [Bun](https://bun.sh) ≥ 1.1：

```bash
bun install
bash scripts/build.sh              # 本机 -> dist/web
bash scripts/build.sh all          # 交叉编译 5 个平台（需联网下载目标运行时）
```

然后 `ln -sf "$PWD/dist/web" ~/.local/bin/web`。

## 安装 agent skill

安装脚本会自动执行这一步，也可以手动：

```bash
web skill install
# Installed web-cli skill: ~/.claude/skills/web-cli/SKILL.md
```

- 默认目录 `~/.claude/skills/web-cli/`，装完新开一个会话即可被 Claude Code 识别。
- 项目级安装：`web skill install --dir .claude/skills/web-cli`（建议提交到仓库）。
- 其他 agent：把 `SKILL.md` 放到它读取 skills 的目录；或者让它运行 `web guide` 获取同一份说明。
- SKILL.md 内嵌在二进制里，不需要联网；本地改过该文件时安装会被拒绝，加 `--force` 覆盖。

## 配置

```bash
web config init    # 写入模板到 ~/.config/agent-web-cli/config.json（权限 600）
web config         # 查看生效配置（密钥打码）
web doctor         # 检查配置、代理、试抓取、试搜索
```

SearXNG 至少需要：

```json
{
  "search": {
    "url": "https://searx.example.com/search",
    "token": "…",
    "authHeader": "Authorization",
    "authScheme": "Bearer"
  }
}
```

SearXNG 服务端必须启用 JSON 输出（`settings.yml` 里 `search.formats: [html, json]`），否则返回 403。

## 升级

重新运行安装脚本即可（会覆盖二进制，skill 内容相同时保持不动）：

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh | bash
web --version
```

## 卸载

```bash
rm -f ~/.local/bin/web
rm -rf ~/.claude/skills/web-cli
rm -rf ~/.config/agent-web-cli ~/.cache/agent-web-cli   # 可选：配置与缓存
```

## Windows

`install.sh` 不支持 Windows。请从 Releases 下载 `web-windows-x64.exe`，放进 `PATH` 中的目录并改名（或直接使用）`web.exe`，然后运行：

```powershell
web.exe skill install
```

## 故障排查

- `web doctor` 会逐项报告配置、代理、抓取和搜索。
- 失败时 stderr 是一行 JSON，`hint` 字段给出下一步建议。
- 退出码：2 参数、3 网络、4 被拒、5 超时、6 不支持（PDF/二进制）、7 SSRF 拦截、8 配置、9 HTTP。
