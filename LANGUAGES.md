# Languages to add to the catalog next

Ranked using three popularity sources: Stack Overflow Developer Survey 2025 (what developers use), GitHub Octoverse 2025 (what's in repos) and TIOBE (search interest, Nov 2026). Already included: PowerShell, Python, C#, JS/TS, Go, Rust, Bash, HTML/CSS.

## Tier 1: high on every list

| Language | Runtime (portable?) | Language server | Run command | Effort |
|---|---|---|---|---|
| Java | Temurin JDK zip (yes) | Eclipse JDT LS (needs Java 21+) | `java "{file}"` (single-file run) | Medium |
| C / C++ | LLVM-MinGW or MinGW-w64 zip (yes) | clangd (zip) | compile with clang/gcc, then run | Medium |
| SQL | sqlite3.exe (yes) | sqls or sql-language-server (npm) | `sqlite3 scratch.db < "{file}"` | Easy |
| PHP | windows.php.net zip (yes) | Intelephense (npm) | `php "{file}"` | Easy |

## Tier 2: popular, and useful for learning

| Language | Runtime | Language server | Run command | Effort |
|---|---|---|---|---|
| Batch / CMD | built into Windows | none (editor highlighting only) | `cmd /c "{file}"` | Very easy |
| Lua | lua zip (yes) | lua-language-server (zip) | `lua "{file}"` | Easy |
| JSON / YAML / Markdown | none (edit only) | JSON built into the editor; yaml-language-server (npm) | preview for Markdown | Easy |
| Dart | Dart SDK zip (yes) | built into the SDK (`dart language-server`) | `dart run "{file}"` | Easy |
| Kotlin | kotlinc zip + JDK | kotlin-language-server | `kotlinc -script "{file}"` (.kts) | Medium |
| Ruby | RubyInstaller (official installer) | ruby-lsp (gem) | `ruby "{file}"` | Medium |
| R | R installer (official installer) | `languageserver` R package | `Rscript "{file}"` | Medium |

## Tier 3: niche but relevant to IT work

| Language | Notes |
|---|---|
| HCL / Terraform | In GitHub's top 10. terraform + terraform-ls are both single portable binaries |
| Dockerfile | Highlighting built into the editor; dockerfile-language-server (npm) |
| Visual Basic (.NET) | Still in TIOBE's top 10; runs through the .NET SDK like C# |
| Perl | Strawberry Perl portable zip; Perl::LanguageServer |

## Suggested order

Batch, SQL (SQLite), PHP, Lua, JSON/YAML/Markdown, then Java and C/C++. The first five are all quick, portable wins. Java and C/C++ need the most setup work.
