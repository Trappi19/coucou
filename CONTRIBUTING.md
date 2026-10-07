# Contributing to Coucou (Windows)

## Getting started

You need [Rust](https://rustup.rs), [Node 20+](https://nodejs.org) and the MSVC build tools (Visual Studio Build Tools, "Desktop development with C++").

```powershell
npm install
npm run tauri dev
```

## Rules of the house

- Secrets go in the Windows Credential Manager, never on disk or in git.
- No telemetry, no network calls except to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook must exit right away.
- Never write `~/.claude/settings.json` without a backup and the user's confirmation.
- Keep it light: 0 % CPU when the island is hidden.

## Pull requests

- One topic per PR, with a short GIF or screenshot for anything visual.
- `cargo check` and `npm run build` must pass with no new warnings.
