First public release of POLY//ISE: a Y2K-styled, ISE-like script editor for Windows.

**Languages:** PowerShell, Python, C#, JavaScript/TypeScript, Go, Rust, Bash, HTML/CSS

**New in 0.1.33**
- Practice folders: sample test data ships with the installer and is set up on first launch in `POLY-ISE-Data\practice` (testdata, output, solutions). Learning mode maps testdata read-only and output writable, and `POLY_DATA` / `POLY_OUTPUT` work in both modes.
- Rust (from 0.1.30–0.1.32): the Setup wizard installs the stable Rust toolchain, hash-checked against rust-lang.org's channel manifest, and Rust scripts run in Learning mode with a warmed local copy of the compiler.

**Highlights**
- IntelliSense through language servers, managed from the Server Manager
- Setup wizard with one-click runtime and server installs, hash-checked downloads
- Learning mode (default): scripts run offline in Windows Sandbox, so nothing changes on your PC. Runs take about 1.5–4 s once warm.
- Live mode: runs on the real PC after UAC approval
- Drag-and-drop command library with about 440 snippets, plus your own commands with the + button
- Per-tab force-stop, music controls, skins

**Install:** download `POLY-ISE-Setup-0.1.33.exe` and run it. No admin rights needed.
Learning mode needs the Windows Sandbox feature turned on.

**Note:** the installer isn't code-signed yet, so Windows SmartScreen may warn. Choose **More info → Run anyway**.
