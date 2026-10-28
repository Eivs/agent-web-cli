# Install and upgrade

[中文](INSTALL.md) | English

`web` is a single-file binary with the Bun runtime embedded; no runtime needs to be installed first.

## One-line install (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh | bash
```

The script:

1. detects the OS and CPU architecture (darwin / linux × x64 / arm64);
2. downloads `web-<os>-<arch>` from the latest GitHub Release;
3. verifies it against `SHA256SUMS` (warns only if the release has none);
4. installs to `~/.local/bin/web` (it tells you if that directory is not on `PATH`);
5. installs the agent skill into `~/.claude/skills/web-cli/`.

Options:

```bash
./install.sh --version v0.1.0      # install a specific version
./install.sh --dir /usr/local/bin  # different install directory (needs write access)
./install.sh --no-skill            # skip the agent skill
./install.sh --force               # overwrite a locally modified SKILL.md
```

Environment variables: `WEB_REPO`, `WEB_VERSION`, `WEB_INSTALL_DIR`, `WEB_BASE_URL` (mirror or local testing).

If you would rather not pipe a download straight into a shell, save it first:

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh -o /tmp/web-install.sh
bash /tmp/web-install.sh
```

## Manual download

Grab the matching file from [Releases](https://github.com/Eivs/agent-web-cli/releases):

| Platform | File |
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

Releases also ship a same-named `.gz` (about a quarter of the size); the installer prefers it. To install a `.gz` by hand:

```bash
gzip -dc web-darwin-arm64.gz > web-darwin-arm64
chmod +x web-darwin-arm64
```

## Build from source

Requires [Bun](https://bun.sh) ≥ 1.1:

```bash
bun install
bash scripts/build.sh              # this machine -> dist/web
bash scripts/build.sh all          # cross-compile five platforms (downloads target runtimes)
```

Then `ln -sf "$PWD/dist/web" ~/.local/bin/web`.

## Install the agent skill

The installer does this automatically; you can also run it yourself:

```bash
web skill install
# Installed web-cli skill: ~/.claude/skills/web-cli/SKILL.md
```

- Default directory `~/.claude/skills/web-cli/`; start a new Claude Code session to pick it up.
- Project-level install: `web skill install --dir .claude/skills/web-cli` (worth committing).
- Other agents: copy `SKILL.md` into whatever directory they load skills from, or have them run `web guide` for the same text.
- `SKILL.md` is embedded in the binary, so no network is needed. Installing refuses to overwrite a locally modified file unless you pass `--force`.

## Configuration

```bash
web config init    # write a template to ~/.config/agent-web-cli/config.json (mode 600)
web config         # show the effective config (secrets masked)
web doctor         # check config, proxy, a test fetch and a test search
```

The minimum for SearXNG:

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

SearXNG must enable JSON output (`search.formats: [html, json]` in `settings.yml`), otherwise it returns 403.

## Upgrade

Re-run the installer (it replaces the binary and leaves an identical skill file alone):

```bash
curl -fsSL https://raw.githubusercontent.com/Eivs/agent-web-cli/main/install.sh | bash
web --version
```

## Uninstall

```bash
rm -f ~/.local/bin/web
rm -rf ~/.claude/skills/web-cli
rm -rf ~/.config/agent-web-cli ~/.cache/agent-web-cli   # optional: config and cache
```

## Windows

`install.sh` does not support Windows. Download `web-windows-x64.exe` from Releases, put it in a directory on `PATH` and rename it to (or use it as) `web.exe`, then run:

```powershell
web.exe skill install
```

## Troubleshooting

- `web doctor` reports config, proxy, fetch and search one by one.
- On failure stderr is one JSON line whose `hint` says what to try next.
- Exit codes: 2 usage, 3 network, 4 blocked, 5 timeout, 6 unsupported (PDF/binary), 7 SSRF, 8 config, 9 HTTP.
