// Opt-in measurement through the native child-process/storage boundary.
// Writes allocated synthetic files; no sparse data and no OS application launch.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const arguments_ = process.argv.slice(2);
assert.equal(arguments_.length % 2, 0, 'Expected --driver PATH and/or --sizes BYTES,BYTES');
const options = new Map();
for (let index = 0; index < arguments_.length; index += 2) {
  assert.ok(['--driver', '--sizes', '--expected-hashes'].includes(arguments_[index]), 'Unknown option');
  assert.ok(!options.has(arguments_[index]), 'Repeated option');
  options.set(arguments_[index], arguments_[index + 1]);
}
const executable = resolve(options.get('--driver') ?? join(__dirname, '../app/src-tauri/target/debug/native-e2e-driver'));
const sizes = (options.get('--sizes') ?? '2000000000').split(',').map(Number);
assert.ok(sizes.length > 0 && sizes.every(size => Number.isSafeInteger(size) && size > 0 && size <= 2_000_000_000));
const expectedHashes = (options.get('--expected-hashes') ?? '2,1').split(',').map(Number);
assert.ok(expectedHashes.length === 2 && expectedHashes.every(count => Number.isInteger(count) && count >= 0 && count <= 2));
const root = fs.mkdtempSync(join(tmpdir(), 'telegram-drive-opening-measure-'));
fs.chmodSync(root, 0o700);
fs.writeFileSync(join(root, '.native-e2e-fixture'), 'telegram-drive-synthetic-e2e\n');
let driver;
(async () => {
  try {
    const driverSha256 = createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    driver = spawn(executable, [root], { stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
    assert.deepEqual(JSON.parse((await replies.next()).value), { ready: true });
    async function request(command) {
      driver.stdin.write(`${JSON.stringify(command)}\n`);
      const reply = JSON.parse((await replies.next()).value);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.value;
    }
    await request({ command: 'seed_account', owner: 101 });
    const block = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < block.length; index++) block[index] = index % 251;
    const cases = [];
    for (const [index, size] of sizes.entries()) {
      const source = `synthetic-${index}.bin`;
      const fd = fs.openSync(join(root, source), 'wx', 0o600);
      try {
        for (let done = 0; done < size;) {
          done += fs.writeSync(fd, block, 0, Math.min(block.length, size - done));
        }
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      assert.equal(fs.statSync(join(root, source)).size, size);
      const file = await request({ command: 'legacy_external_seed', owner: '101', source, category: 'offline', id: index + 1 });
      const measurements = [];
      for (const label of ['first legacy open', 'subsequent open']) {
        const before = await request({ command: 'external_file_status' });
        const start = performance.now();
        await request({ command: 'external_file_open', path: file.path });
        const seconds = (performance.now() - start) / 1000;
        const after = await request({ command: 'external_file_status' });
        const hashedBytes = after[1] - before[1];
        assert.equal(hashedBytes, size * expectedHashes[label === 'first legacy open' ? 0 : 1]);
        measurements.push({ label, seconds, hashedBytes });
      }
      cases.push({ bytes: size, measurements });
    }
    console.log(JSON.stringify({
      platform: process.platform, driver: executable, driverSha256,
      build: 'profile must be established by the recorded Cargo command and build log',
      cache: 'warm allocated synthetic files; synthetic file writes and fixture setup precede timed opens; no cache purge',
      coldCache: 'UNMEASURED', osApplicationDispatch: 'controlled path sink only', cases,
    }, null, 2));
    driver.stdin.end(`${JSON.stringify({ command: 'shutdown' })}\n`);
    const code = await new Promise(done => driver.exitCode !== null ? done(driver.exitCode) : driver.once('exit', done));
    assert.equal(code, 0, 'Native driver did not exit cleanly');
  } finally {
    if (driver && driver.exitCode === null) driver.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
