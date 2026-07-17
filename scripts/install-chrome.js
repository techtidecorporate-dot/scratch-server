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

const require = createRequire(import.meta.url);

// A system-provided browser is authoritative; nothing to download.
if (process.env.PUPPETEER_EXECUTABLE_PATH) {
  console.log(
    `Using system browser at ${process.env.PUPPETEER_EXECUTABLE_PATH} — skipping Chrome download.`
  );
  process.exit(0);
}

const { existsSync } = await import('fs');
const puppeteer = (await import('puppeteer')).default;

try {
  const path = puppeteer.executablePath();
  if (existsSync(path)) {
    console.log(`Chrome already present at ${path}`);
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
try {
  console.log(`Chrome installed at ${puppeteer.executablePath()}`);
} catch (err) {
  console.error(`Chrome installed but could not be resolved: ${err.message}`);
  process.exit(1);
}
