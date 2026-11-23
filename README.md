# POLY//ISE

A Y2K-styled, ISE-like script editor and tester for many languages: PowerShell, Python, C#, JavaScript/TypeScript, Go, Rust, Bash and HTML/CSS.

## Install (users)

Run `POLY-ISE-Setup-<version>.exe`. On first launch the **Setup wizard** offers the language runtimes and IntelliSense servers, with the recommended ones pre-checked. No admin rights are needed. You can reopen it any time from **Servers → Setup wizard**.

Where things go:
- The app installs to `%LOCALAPPDATA%\Programs\POLY-ISE` (or the folder you pick).
- Runtimes, language servers, settings and your own library commands go to `%LOCALAPPDATA%\POLY-ISE-Data`, so updates and uninstalls don't touch them.
- Portable mode: put an empty file named `portable` next to `POLY-ISE.exe` and everything stays beside the exe.

Nothing else needs to be installed for the app itself:
- PowerShell uses the Windows PowerShell that ships with Windows.
- The music bar uses a PowerShell script (`tools/media-helper.ps1`), so no .NET is needed.
- JS/TS and HTML/CSS IntelliSense are built into the editor.

## Learning and Live mode

- **Learning** (default): every run happens inside Windows Sandbox, offline, so scripts can't change this PC, the network or Active Directory. The sandbox starts hidden in the background at launch and is reused, so runs take about 1.5–4 seconds once it's warm (a couple of minutes after launch). Needs the Windows Sandbox feature turned on.
- **Live**: runs on the real PC. Switching to Live asks for administrator approval (UAC) and lasts until the app closes.
- In Learning mode, C# compiles offline with the SDK's compiler, so NuGet packages aren't available.

## Command library

Each language has its own library of drag-and-drop snippets in `library/<lang>.json`. The **+** button at the top of the library adds your own command (name, description, category, code). Your commands are tagged **MINE**, can be edited or deleted with ✎, and are saved in `POLY-ISE-Data\data\custom-library.json`.

## Build (developers)

Needs Node.js 20 or newer.

```powershell
npm install
npm start          # run from source (data stays in the project folder)
npm run dist       # builds dist\POLY-ISE-Setup-<version>.exe
```

`build/library_additions.py` is the script that added the expanded library entries; it skips names that already exist, so it's safe to rerun.

## How downloads stay safe

`catalog/catalog.json` doesn't hard-code versions. Each entry has a `source` that looks up the newest release, plus the vendor's own published SHA-256, at install time:

| Item | Version from | Hash from |
|---|---|---|
| Node.js | nodejs.org release index | nodejs.org `SHASUMS256.txt` |
| Go | go.dev/dl JSON | go.dev (same JSON) |
| GitHub-hosted (PowerShell Editor Services, OmniSharp, rust-analyzer, PortableGit, PowerShell 7) | latest GitHub release | GitHub's asset `digest` |
| Python | python.org FTP listing | python.org API when available, else HTTPS-only |
| .NET SDK | Microsoft's `dotnet-install.ps1` | the script verifies its own downloads |
| Pyright, bash-language-server | pinned npm version | npm integrity hashes |
| gopls | `go install` | Go checksum database |

If a published hash exists, the file must match it or it is deleted. Entries marked `"trust": "https"` are allowed when the vendor publishes no hash. To pin an exact version instead, add `"pin": { "version", "url", "sha256" }` inside `source`. Each install writes `.installed.json` (version, URL, SHA-256, where the hash came from) into its folder.

## Tested

Tested on Windows 11 (TECH-GB-1026) in both modes: PowerShell, Python, C#, JavaScript, Go, Bash and the HTML preview, plus IntelliSense, the Setup wizard, Server Manager, music controls, force-stop and custom library commands. Rust hasn't been run end to end yet.

Logs are in `POLY-ISE-Data\data\logs\`.

## Folder layout

```
main.js, preload.js        Electron main process + safe bridge
src/main/                  runner (F5/F8/sessions), lsp client, server manager, resolvers, downloads, media
renderer/                  UI: index.html, styles.css (skins), app.js, lsp-bridge.js, sounds.js
languages/*.json           one profile per language (the plug-in system)
library/*.json             command library per language
catalog/catalog.json       where runtimes/servers come from (moves to GitHub later)
tools/media-helper.ps1     music controls
src/main/sandbox.js        Learning mode: the Windows Sandbox agent and job runner
build/                     installer icon, NSIS include, afterPack hook
runtimes/  servers/  data/ created at runtime (in POLY-ISE-Data when installed)
```

## Adding a language

1. Copy a file in `languages/` and change `id`, `name`, `extensions`, `monaco` (Monaco language id), `runtime`, `run`, `repl`, `lsp`.
2. Add `library/<lang>.json`.
3. Add catalog entries for its runtime/server, plus an item in `setup`.
4. Restart.

Later, point `config.json → catalogUrl` at a raw catalog file in your GitHub repo, and set `catalogRepo` so "Request a language" opens an issue there.
