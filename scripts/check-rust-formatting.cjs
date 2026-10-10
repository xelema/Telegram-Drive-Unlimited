const fs = require('node:fs');
const path = require('node:path');

// Rustfmt can abandon an enclosing function when it cannot wrap a dense
// fixture macro. Keep the reviewed hot paths readable as a separate static gate.
const root = path.resolve(__dirname, '..');
const files = [
  'app/src-tauri/src/native_e2e.rs',
  'app/src-tauri/tests/native_e2e.rs',
  'app/src-tauri/src/external_files.rs',
  'app/src-tauri/src/heic.rs',
  'app/src-tauri/src/process_budget.rs',
  'app/src-tauri/src/legacy_external.rs',
  'app/src-tauri/src/file_inventory.rs',
  'app/src-tauri/src/local_search.rs',
  'app/src-tauri/src/commands/search.rs',
];
let failed = false;
for (const file of files) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.length <= 200) continue;
    console.error(`[rust-formatting] ${file}:${index + 1}: ${line.length} characters; split the expression or literal.`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('[rust-formatting] Reviewed native paths contain no lines over 200 characters; run cargo fmt --all -- --check as well.');
