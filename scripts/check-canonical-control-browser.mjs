import { spawnSync } from 'node:child_process';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright ES module. This check requires Chrome and real browser execution; it does not count skipped tests as verification.');
const result = spawnSync(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1','apps/control-web/test/canonical-permissions.test.mjs','apps/control-web/test/local-auth.test.mjs'],{stdio:'inherit',env:process.env});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
