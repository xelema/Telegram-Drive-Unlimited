const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const cli = path.resolve(__dirname, '../packaged-startup-smoke.cjs');
const app = path.join(__dirname, 'fixtures/startup-smoke-app.cjs');
function journey(t, mode, extra = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-packaged-cli-e2e-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidence = path.join(directory, 'evidence.json');
  const result = spawnSync(process.execPath, [cli, '--disposable-user', '--executable', process.execPath,
    '--args-json', JSON.stringify([app, mode, evidence]), '--timeout-ms', process.platform === 'win32' ? '20000' : '8000', ...extra], { encoding: 'utf8', timeout: 45000 });
  assert.ifError(result.error);
  return { result, evidence, record: fs.existsSync(evidence) && JSON.parse(fs.readFileSync(evidence, 'utf8')) };
}
test('smoke CLI accepts numeric-leading nonce with a valid isolated identity and removes the private profile', t => {
  const token = '0' + randomBytes(16).toString('hex').slice(1);
  const { result, record } = journey(t, 'ready', ['--run-token', token, '--expected-bundle-type', 'nsis']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record.token, token);
  assert.equal(record.identifier, `com.cameronamer.telegramdrive.smoke.r${token}`);
  assert.equal(fs.existsSync(record.root), false);
});
test('smoke CLI rejects incorrect runtime package metadata', t => {
  const { result, record } = journey(t, 'wrong-kind', ['--expected-bundle-type', 'nsis']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bundle type.*nsis/i);
  assert.equal(fs.existsSync(record.root), false);
});
test('early exit keeps the startup failure and reaps surviving descendants before cleanup', t => {
  const { result, evidence, record } = journey(t, 'orphan');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture startup failed/);
  const pid = Number(fs.readFileSync(`${evidence}.child`, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Descendant must report a valid PID');
  if (process.platform === 'win32') {
    const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(`"${pid}"`), check.stdout);
  } else {
    // A briefly unreaped Unix zombie cannot run or retain the lock descriptor.
    const check = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    assert.ok(check.status !== 0 || /^Z/.test(check.stdout.trim()), check.stdout);
  }
  fs.rmSync(`${evidence}.child.lock`);
  assert.equal(fs.existsSync(record.root), false);
});
test('readiness deadline fails and cleans up the private launch', t => {
  const { result, record } = journey(t, 'deadline', ['--timeout-ms', process.platform === 'win32' ? '10000' : '250']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /before deadline/);
  assert.equal(fs.existsSync(record.root), false);
});
test('Windows rejects readiness followed by natural application exit while its descendants are reaped', { skip: process.platform !== 'win32' }, t => {
  const { result, record, evidence } = journey(t, 'ready-exit');
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /early exit|exited naturally/);
  assert.doesNotMatch(result.stdout, /Startup readiness passed/);
  const pid = Number(fs.readFileSync(`${evidence}.child`, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Descendant must report a valid PID');
  const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr); assert.ok(!check.stdout.includes(`"${pid}"`), check.stdout);
  fs.rmSync(`${evidence}.child.lock`);
  assert.equal(fs.existsSync(record.root), false);
});
test('Windows smoke preserves the OS KnownFolder profile environment', { skip: process.platform !== 'win32' }, t => {
  const { result, record } = journey(t, 'ready');
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.equal(record[name], process.env[name]);
});

function capturedProcess(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', error;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', value => { error = value; });
  let closed = false;
  const completion = new Promise(resolve => child.once('close', status => {
    closed = true; resolve({ status, stdout, stderr, error });
  }));
  return { child, completion, get closed() { return closed; } };
}
async function boundedCompletion(process, milliseconds) {
  let timer;
  try {
    return await Promise.race([process.completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned fixture process exceeded its deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function lockedProfileJourney(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'td-packaged-lock-e2e-'));
  const evidence = path.join(directory, 'evidence.json');
  // This sibling is created by the test runner, never by the smoke application,
  // so the application Job cannot reap its delete-denying Windows handle.
  const locker = capturedProcess('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    path.join(__dirname, 'fixtures/startup-profile-lock.ps1'), '-Evidence', evidence, '-Mode', mode]);
  let launch, record;
  t.after(async () => {
    const errors = [];
    const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
    await attempt(() => fs.writeFileSync(`${evidence}.stop-locker`, 'stop'));
    // Cache valid evidence in the journey, and recover it if an earlier assertion
    // interrupted the journey while the fixture was still publishing its record.
    await attempt(async () => {
      const deadline = Date.now() + 2000;
      let readError;
      while (!record && Date.now() < deadline) {
        try {
          const value = JSON.parse(fs.readFileSync(evidence, 'utf8'));
          if (typeof value.root !== 'string' || typeof value.identifier !== 'string') throw new Error('Invalid fixture cleanup record');
          record = value;
        } catch (error) { readError = error; await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      if (!record && fs.existsSync(evidence)) throw readError;
    });
    // Request controlled Job shutdown before any last-resort CLI tree kill.
    await attempt(() => {
      if (record && fs.existsSync(record.root)) fs.writeFileSync(path.join(record.root, 'windows-launch.json.stop'), 'stop');
    });
    const reap = async (owned, timeout, tree) => {
      if (!owned) return;
      try { await boundedCompletion(owned, timeout); }
      catch {
        try {
          if (!owned.closed && owned.child.exitCode === null && owned.child.signalCode === null && owned.child.pid) {
            if (tree) {
              const killed = spawnSync('taskkill', ['/PID', String(owned.child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000 });
              assert.ifError(killed.error);
              assert.equal(killed.status, 0, killed.stderr);
            } else owned.child.kill();
          }
        } finally { await boundedCompletion(owned, 5000); }
      }
    };
    // A failed stop/write/kill must never prevent reaping the other owned process.
    const outcomes = await Promise.allSettled([reap(locker, 5000, false), reap(launch, 15000, true)]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
    await attempt(() => { if (record) fs.rmSync(record.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
    await attempt(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    if (errors.length) throw new AggregateError(errors, 'Owned Windows lock fixture cleanup failed');
  });
  launch = capturedProcess(process.execPath, [cli, '--disposable-user', '--executable', process.execPath,
    '--args-json', JSON.stringify([app, 'ready-lock', evidence]), '--timeout-ms', '20000']);
  const result = await boundedCompletion(launch, 45000);
  assert.ifError(result.error);
  assert.ok(fs.existsSync(`${evidence}.acquired`), 'Readiness must follow acquisition of a real delete-denying handle');
  record = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  const acquired = JSON.parse(fs.readFileSync(`${evidence}.acquired`, 'utf8'));
  assert.equal(acquired.profile, path.join(record.root, record.identifier));
  assert.equal(acquired.pid, locker.child.pid, 'The lock is owned outside the smoke application Job');
  if (mode === 'transient') {
    const lockResult = await boundedCompletion(locker, 10000);
    assert.ifError(lockResult.error);
    assert.equal(lockResult.status, 0, lockResult.stderr);
    const released = JSON.parse(fs.readFileSync(`${evidence}.released`, 'utf8'));
    assert.equal(released.reaped, true, 'Lock must survive confirmed application Job reaping');
    assert.ok(released.held_after_reap_ms >= 750, 'Hold the external handle for at least 750 ms after Job reaping');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Startup readiness passed/);
    assert.equal(fs.existsSync(acquired.profile), false);
    assert.equal(fs.existsSync(record.root), false);
  } else {
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /EBUSY|EPERM|ENOTEMPTY/);
    assert.doesNotMatch(result.stdout, /Startup readiness passed/);
    assert.equal(fs.existsSync(`${evidence}.released`), false, 'Persistent handle must still be held when cleanup fails');
    assert.equal(fs.existsSync(path.join(record.root, 'windows-launch.json.reaped')), true);
    assert.equal(fs.existsSync(acquired.profile), true, 'Persistent lock must remain a hard cleanup failure');
  }
}
test('Windows smoke retries a transient profile database lock after owned Job reaping',
  { skip: process.platform !== 'win32', timeout: 90000 }, t => lockedProfileJourney(t, 'transient'));
test('Windows smoke fails closed when an external profile database lock persists',
  { skip: process.platform !== 'win32', timeout: 90000 }, t => lockedProfileJourney(t, 'persistent'));
