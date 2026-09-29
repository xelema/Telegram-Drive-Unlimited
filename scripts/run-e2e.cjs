// Run the host E2E suites. Android device acceptance is a separate local command.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const suites = [
  [process.execPath, ['scripts/check-test-policy.cjs']],
  [process.execPath, ['scripts/check-app-security.cjs']],
  [process.execPath, ['scripts/e2e/assurance.e2e.cjs']],
  [npm, ['run', 'test:e2e', '--prefix', 'app']],
  [npm, ['run', 'test:e2e', '--prefix', 'supporter-service']],
  ['cargo', ['test', '--locked', '--manifest-path', 'app/src-tauri/Cargo.toml', '--features', 'native-e2e', '--test', 'native_e2e']],
];
for (const [command, args] of suites) {
  console.log(`[e2e] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // npm.cmd requires cmd.exe; all commands and arguments above are fixed.
    shell: process.platform === 'win32' && command === npm,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[e2e] All host end-to-end suites passed.');
