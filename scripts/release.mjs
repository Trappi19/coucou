// Local release: bump the version, build the installers, and hand the new
// setup to the installed Coucou, which offers it from the island.
//
//   npm run release            0.1.1 → 0.1.2
//   npm run release -- minor   0.1.1 → 0.2.0
//   npm run release -- major   0.1.1 → 1.0.0
//   npm run release -- 0.3.0   exactly that
//
// The version lives in three places that must agree (CLAUDE.md): package.json,
// Cargo.toml and src-tauri/tauri.conf.json — plus package-lock.json, kept in
// step. If the build fails, all four are put back as they were.
//
// Nothing leaves the machine: the setup is copied to
// %LOCALAPPDATA%\Coucou\updates next to a latest.json that Coucou reads.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  pkg: join(root, "package.json"),
  lock: join(root, "package-lock.json"),
  cargo: join(root, "Cargo.toml"),
  tauri: join(root, "src-tauri", "tauri.conf.json"),
};

const original = Object.fromEntries(
  Object.entries(files).map(([k, f]) => [k, readFileSync(f, "utf8")]),
);
const current = JSON.parse(original.tauri).version;

function next(version, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const [major, minor, patch] = version.split(".").map((n) => parseInt(n, 10) || 0);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  console.error(`Unknown bump "${how}" — use patch, minor, major or an exact x.y.z.`);
  process.exit(1);
}

const version = next(current, process.argv[2] ?? "patch");
console.log(`\n  Coucou ${current} → ${version}\n`);

// ── Bump ─────────────────────────────────────────────────────────────────────

/** The first top-level "version" only, so the rest of the file keeps its layout. */
function setTopVersion(text, name) {
  const out = text.replace(/^(\s{2}"version":\s*")[^"]+(")/m, `$1${version}$2`);
  if (out === text) {
    console.error(`Could not find the version in ${name}.`);
    process.exit(1);
  }
  return out;
}

function bump() {
  writeFileSync(files.pkg, setTopVersion(original.pkg, "package.json"));
  writeFileSync(files.tauri, setTopVersion(original.tauri, "tauri.conf.json"));
  // npm writes the lock file exactly like this: two spaces, final newline.
  const lock = JSON.parse(original.lock);
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  writeFileSync(files.lock, `${JSON.stringify(lock, null, 2)}\n`);
  // Only the [workspace.package] version, not some dependency's.
  const cargo = original.cargo.replace(
    /(\[workspace\.package\][^[]*?\nversion\s*=\s*")[^"]+(")/,
    `$1${version}$2`,
  );
  if (cargo === original.cargo) {
    console.error("Could not find the version in Cargo.toml's [workspace.package].");
    process.exit(1);
  }
  writeFileSync(files.cargo, cargo);
}

function restore() {
  for (const [k, f] of Object.entries(files)) writeFileSync(f, original[k]);
  console.error(`\n  Build failed — version put back to ${current}.\n`);
}

// ── Build ────────────────────────────────────────────────────────────────────

bump();
// `npm run pack` = tauri build (which builds the hook relay first) + copy to release/.
// One fixed command string: npm is a .cmd on Windows, so it needs a shell.
const build = spawnSync("npm run pack", { cwd: root, stdio: "inherit", shell: true });
if (build.status !== 0) {
  restore();
  process.exit(build.status ?? 1);
}

// ── Hand it to the installed Coucou ──────────────────────────────────────────

const setupName = `Coucou-Windows-${version}-setup.exe`;
const setup = join(root, "release", setupName);
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) {
  console.error("LOCALAPPDATA is not set: cannot reach Coucou's updates folder.");
  process.exit(1);
}
const updates = join(localAppData, "Coucou", "updates");
mkdirSync(updates, { recursive: true });

// Older setups are of no use once a newer one is there.
for (const f of readdirSync(updates)) {
  if (f.endsWith("-setup.exe") && f !== setupName) {
    try {
      unlinkSync(join(updates, f));
    } catch {
      // Still open somewhere: it will go next time.
    }
  }
}
copyFileSync(setup, join(updates, setupName));
// Written last: Coucou only looks at the setup once this names it.
writeFileSync(
  join(updates, "latest.json"),
  `${JSON.stringify({ version, file: setupName, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

console.log(`  Coucou ${version} is in ${updates}`);
console.log("  Mochi will offer it within a minute (or tray → Check for updates).\n");
