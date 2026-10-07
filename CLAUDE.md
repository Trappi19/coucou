# Coucou (Windows) — guide for AI coding agents

Windows-only fork of Coucou. Mochi, a small animated character living at the top of the screen, shows AI coding agent sessions (Claude Code, Gemini CLI, Antigravity and more) and a few integrations, and lets the user approve, answer, chat and drop files from the island.

## Where things are
- `src-tauri/` — Rust backend (Tauri 2): island window, named pipe server, Claude API, pollers. Everything Win32 lives in `src/platform/windows.rs`.
- `hook/` — `coucou-hook.exe`, the relay Claude Code runs on every hook event (named pipe `\\.\pipe\coucou-<sid>`).
- `src/` — TypeScript front end, no framework: `mochi/` (Canvas 2D), `island/`, `views/`, `settings/`.
- `sounds/` — the 28 WAV sounds, served/copied by `vite.config.ts`.
- `docs/SPEC.md`, `docs/INTEGRATIONS.md` — behaviour, views, states, integrations (in French, written for the original macOS app). `docs/AGENTS.md` — third-party agents.
- `design/prototype/notch-buddy.html` — original prototype, the visual source of truth. `design/captures/` — target screenshots.

## Build
```
npm install
npm run tauri dev   # dev build
npm run pack        # NSIS + MSI installers in release/
```
Needs Rust (MSVC toolchain), Node 20+, Visual Studio Build Tools ("Desktop development with C++").

## Rules
- Secrets live in the Windows Credential Manager, never on disk or in git.
- No telemetry. Network calls only to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code or Codex permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Keep the identifier `fr.louisraille.coucou` (Credential Manager entries and preferences depend on it).
- Pill IDs are stable contract values (Credential Manager, settings, hook routing): never rename an existing pill ID.
- New views follow the existing app style.
- Versions live in three places that must agree: `package.json`, `Cargo.toml`, `src-tauri/tauri.conf.json`.
