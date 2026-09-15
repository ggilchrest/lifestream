import test from 'node:test';
import { execFileSync } from 'node:child_process';

test('checked-in provider types reproduce from the current published schema closure', () => {
  execFileSync(process.execPath, ['scripts/generate-provider-types.mjs', '--check'], {
    cwd: new URL('../../../', import.meta.url), stdio: 'pipe'
  });
});
