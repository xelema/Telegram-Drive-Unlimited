#!/usr/bin/env node
const { tagPolicy } = require('./release-tag-policy.cjs');
async function upsertDraft(github, context, tag, body) {
  const policy = tagPolicy(tag), repo = context.repo;
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.some(release => !release.draft)) throw new Error('Tag is already published; refusing to turn it back into a draft');
  if (matches.length > 1) throw new Error('Multiple matching drafts require owner reconciliation');
  const data = { ...repo, body, draft: true, prerelease: policy.prerelease, make_latest: 'false' };
  const response = matches.length
    ? await github.rest.repos.updateRelease({ ...data, release_id: matches[0].id })
    : await github.rest.repos.createRelease({ ...data, tag_name: tag, name: `Telegram Drive ${tag}` });
  return response.data.id;
}
async function publish(github, context, releaseId, tag) {
  const policy = tagPolicy(tag);
  return await github.rest.repos.updateRelease({ ...context.repo, release_id: Number(releaseId), draft: false, prerelease: policy.prerelease, make_latest: policy.make_latest });
}
// This CLI is deliberately restricted to local fixture APIs. Workflow callers
// use the exported operations with the authenticated GitHub Actions client.
if (require.main === module) (async () => {
  const fs = require('node:fs'), options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i]; if (flag === '--publish') options.publish = true;
    else if (['--fixture-api', '--repo', '--tag', '--body-file'].includes(flag)) options[flag] = process.argv[++i];
    else throw new Error(`Unknown flag ${flag}`);
  }
  const base = new URL(options['--fixture-api']);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('CLI API must be an explicit loopback fixture');
  const [owner, repo] = (options['--repo'] || '').split('/'); if (!owner || !repo) throw new Error('Fixture repo required');
  async function request(method, route, body) {
    const response = await fetch(new URL(route, base), { method, redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Fixture API ${response.status}`); return { data: await response.json() };
  }
  const github = { rest: { repos: { listReleases: true,
    createRelease: data => request('POST', `/repos/${owner}/${repo}/releases`, data),
    updateRelease: data => request('PATCH', `/repos/${owner}/${repo}/releases/${data.release_id}`, data) } },
    paginate: async () => { const rows = []; for (let page = 1; page <= 100; page++) { const { data } = await request('GET', `/repos/${owner}/${repo}/releases?page=${page}`); if (!data.length) return rows; rows.push(...data); } throw new Error('Fixture pagination did not terminate'); } };
  const context = { repo: { owner, repo } }, tag = options['--tag'];
  if (options.publish) {
    const releases = await github.paginate(); const draft = releases.find(value => value.tag_name === tag && value.draft); if (!draft) throw new Error('No matching draft');
    await publish(github, context, draft.id, tag); console.log('Published fixture release');
  } else console.log(await upsertDraft(github, context, tag, fs.readFileSync(options['--body-file'], 'utf8')));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { upsertDraft, publish };
