// Opt-in synthetic HEIC measurements through the native process/cache boundary.
// Real sips/FFmpeg only; a missing decoder or failed journey is an error, never a pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const fixtureDir = resolve(__dirname, '../app/src-tauri/test-support/fixtures/heic');
const driverPath = resolve(__dirname, '../app/src-tauri/target/debug/native-e2e-driver');
const large = process.argv[2];
assert(large, 'Supply the synthetic8064x6048 HEIC path; never use photographs.');
(async () => {
  const measurements = [];
  for (const decoder of ['sips', 'ffmpeg']) {
    for (const [label, source, dimensions] of [
      ['12MP', join(fixtureDir, 'tiled-12mp.heic'), [4032, 3024]],
      ['48MP', resolve(large), [8064, 6048]],
      ['rotation', join(fixtureDir, 'rotated.heic'), [180, 240]],
      ['mirror', join(fixtureDir, 'mirrored.heic'), [240, 180]],
    ]) {
      const root = fs.mkdtempSync('/private/tmp/telegram-drive-heic-measure-');
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(join(root, '.native-e2e-fixture'), 'telegram-drive-synthetic-e2e\n');
      fs.copyFileSync(source, join(root, 'synthetic.heic'));
      fs.copyFileSync(join(fixtureDir, 'small-reference.jpg'), join(root, 'reference.jpg'));
      const driver = spawn(driverPath, [root], { stdio: ['pipe', 'pipe', 'inherit'] });
      const replies = createInterface({ input: driver.stdout })[Symbol.asyncIterator]();
      try {
        assert.deepEqual(JSON.parse((await replies.next()).value), { ready: true });
        async function request(value) {
          driver.stdin.write(`${JSON.stringify(value)}\n`);
          const reply = JSON.parse((await replies.next()).value);
          assert.equal(reply.ok, true, JSON.stringify(reply));
          return reply.value;
        }
        await request({ command: 'seed_account', owner: 101 });
        const start = performance.now();
        const value = { command: 'asset_display_read', owner: '101', source: 'synthetic.heic', filename: 'Synthetic.heic', extension: 'heic', mime: 'image/heic', heicTools: decoder };
        driver.stdin.write(`${JSON.stringify(value)}\n`);
        const reply = JSON.parse((await replies.next()).value);
        const result = reply.value;
        const pipelineSeconds = (performance.now() - start) / 1000;
        const status = await request({ command: 'heic_status' });
        if (!reply.ok) {
          measurements.push({ label, decoder, error: reply.error, pipelineSeconds, ...status });
          if (label === '12MP' || label === '48MP') process.exitCode = 1;
          continue;
        }
        assert.equal(status.decodes.length, 1);
        assert.equal(status.decodes[0].decoder, decoder);
        if (label === 'rotation' || label === 'mirror') fs.copyFileSync(result.path, `/private/tmp/telegram-drive-heic-synthetic/${decoder}-${label}.jpg`);
        let orientation;
        if (label === '12MP') {
          fs.copyFileSync(join(fixtureDir, 'tiled-12mp-reference.jpg'), join(root, 'reference12.jpg'));
          orientation = await request({command: 'heic_expected_pixels', path: result.path.slice(root.length + 1), reference: 'reference12.jpg'});
          assert(orientation.meanAbsoluteChannelError < 32, JSON.stringify({decoder, label, orientation}));
        }
        if (label === 'rotation' || label === 'mirror') {
          orientation = await request({command: 'heic_expected_pixels', path: result.path.slice(root.length + 1), reference: 'reference.jpg', transform: label});
          assert(orientation.meanAbsoluteChannelError < 12, JSON.stringify({decoder, label, orientation}));
        }
        measurements.push({ label, decoder, orientation, sourceDimensions: dimensions, sourceBytes: fs.statSync(source).size, renditionBytes: fs.statSync(result.path).size, pipelineSeconds, ...status });
      } finally {
        driver.stdin.end(`${JSON.stringify({ command: 'shutdown' })}\n`);
        await new Promise(resolve => driver.once('exit', resolve));
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  console.log(JSON.stringify({ platform: process.platform, mode: 'debug native driver', measurements }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
