/**
 * Ensures the Chrome build that this project's Puppeteer version pins is present
 * before the server starts.
 *
 * Puppeteer's own postinstall hook normally does this, but managed hosts often
 * run `npm install --ignore-scripts`, so the hook never fires and `.launch()`
 * fails at runtime with "Could not find Chrome (ver. X)". Running the install
 * from the build phase does not depend on lifecycle scripts being enabled.
 *
 * Idempotent: if Chrome already resolves, this exits without downloading.
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { chmodSync, statSync, existsSync } from 'fs';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);

/**
 * Puppeteer does not chmod the browser it downloads. The execute bit comes
 * solely from the zip's external file attributes, applied by extract-zip via
 * `createWriteStream(dest, {mode})` — and open(2) masks that mode with the
 * process umask. A build environment with a restrictive umask therefore yields
 * a Chrome binary that exists but cannot be spawned (EACCES).
 *
 * Chrome also spawns its own helper binaries, which need the same treatment.
 */
const ensureExecutable = (binary) => {
  if (process.platform === 'win32') return;

  const helpers = ['chrome_crashpad_handler', 'chrome_sandbox'].map((name) =>
    join(dirname(binary), name)
  );

  for (const file of [binary, ...helpers]) {
    if (!existsSync(file)) continue;
    const before = statSync(file).mode & 0o777;
    if ((before & 0o111) === 0o111) continue;
    chmodSync(file, 0o755);
    console.log(
      `Set execute bit on ${file} (${before.toString(8)} -> ${(statSync(file).mode & 0o777).toString(8)})`
    );
  }
};

// A system-provided browser is authoritative; nothing to download.
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  console.log(
    `Using system browser at ${process.env.PUPPETEER_EXECUTABLE_PATH} — skipping Chrome download.`
  );
  process.exit(0);
}

/**
 * Actually executing the binary is the only reliable way to tell the two
 * remaining EACCES causes apart: access(2) does NOT account for a filesystem
 * mounted `noexec`, so a permission check would wrongly report success there.
 *
 * Warns rather than fails: the rest of the API (auth, campaigns, lead listing)
 * does not need a browser, and blocking the deploy over a platform limitation
 * would take those down too.
 */
const verifyLaunchable = (binary) => {
  if (process.platform === 'win32') return;

  try {
    const version = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`Browser is executable: ${version.trim()}`);
  } catch (err) {
    if (err.code === 'EACCES') {
      console.warn(
        `WARNING: ${binary} is still not executable after chmod.\n` +
          '  The execute bit is set, so this points at the filesystem being mounted\n' +
          '  `noexec`. That cannot be fixed from application code — the Lead Finder\n' +
          '  needs a host that permits executing downloaded binaries (a VPS).'
      );
      return;
    }
    console.warn(
      `WARNING: browser present and executable, but did not run: ${err.message}\n` +
        '  If this mentions shared libraries, Chromium\'s system dependencies\n' +
        '  (libnss3, libatk-1.0, libgbm) are missing and need root to install.'
    );
  }
};

const puppeteer = (await import('puppeteer')).default;

try {
  const path = puppeteer.executablePath();
  if (existsSync(path)) {
    console.log(`Chrome already present at ${path}`);
    ensureExecutable(path);
    verifyLaunchable(path);
    process.exit(0);
  }
  console.log(`Chrome expected at ${path} but not found — installing.`);
} catch {
  console.log('Chrome not resolvable — installing.');
}

// Resolve the CLI through the installed package rather than `npx`, which may hit
// the network or a missing cache on a locked-down build container.
const cli = require.resolve('puppeteer/lib/esm/puppeteer/node/cli.js');

// The CLI is declared with prefixCommand 'browsers', so the subcommand path is
// `browsers install chrome`. Without the prefix it silently does nothing.
try {
  execFileSync(process.execPath, [cli, 'browsers', 'install', 'chrome'], { stdio: 'inherit' });
} catch (err) {
  console.error(`Failed to install Chrome: ${err.message}`);
  // Fail the build. A green deploy with no browser is exactly the silent
  // zero-results failure this script exists to prevent.
  process.exit(1);
}

// Verify separately from the install so a resolution failure is never reported
// as a download failure.
let installed;
try {
  installed = puppeteer.executablePath();
  console.log(`Chrome installed at ${installed}`);
} catch (err) {
  console.error(`Chrome installed but could not be resolved: ${err.message}`);
  process.exit(1);
}

ensureExecutable(installed);
verifyLaunchable(installed);
