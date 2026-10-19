import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBoundary, assertCurrentTarget, assertIntakeBoundary, isNewsFile, prepareCandidate, prepareIntakeSync, syncIntake } from './news-promotion.ts';

const article = 'website/outstatic/content/2026-posts/story.en.mdx';
const secondArticle = 'website/outstatic/content/2026-posts/other.en.mdx';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'news-promotion-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name, contents) => { fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true }); fs.writeFileSync(path.join(directory, name), contents); };
  const commit = (message) => { git('add', '.'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-b', 'main');
  git('config', 'user.name', 'News Test');
  git('config', 'user.email', 'test@example.invalid');
  write(article, 'original\n');
  write(secondArticle, 'other article\n');
  write('.github/workflows/validate-news.yml', 'trusted validator\n');
  commit('Initial News');
  git('branch', 'cms'); git('branch', 'test'); git('branch', 'cms-test');
  return { directory, git, write, commit };
}

function remoteFixture(t) {
  const f = fixture(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'news-intake-remote-'));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  f.git('init', '--bare', remote);
  f.git('remote', 'add', 'origin', remote);
  f.git('push', 'origin', 'main', 'cms', 'test', 'cms-test');
  const remoteHead = branch => f.git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`).split(/\s/u)[0];
  const writer = fs.mkdtempSync(path.join(os.tmpdir(), 'news-intake-writer-'));
  t.after(() => fs.rmSync(writer, { recursive: true, force: true }));
  f.git('clone', remote, writer);
  const edit = (branch, file, contents) => {
    const run = (...args) => execFileSync('git', args, { cwd: writer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    run('fetch', 'origin'); run('switch', '-C', branch, `origin/${branch}`);
    fs.writeFileSync(path.join(writer, file), contents);
    run('add', file);
    run('-c', 'user.name=Concurrent Editor', '-c', 'user.email=editor@example.invalid', 'commit', '-m', 'Concurrent saved edit');
    run('push', 'origin', branch);
    return remoteHead(branch);
  };
  return { ...f, remoteHead, edit };
}

test('unchanged and already promoted source snapshots do nothing', t => {
  const f = fixture(t);
  assert.equal(prepareCandidate(f.directory, 'cms', 'main'), null);
  f.git('switch', 'cms'); f.write(article, 'published edit\n'); f.commit('CMS edit');
  const candidate = prepareCandidate(f.directory, 'cms', 'main');
  f.git('branch', '-f', 'main', candidate.candidateSha);
  assert.equal(prepareCandidate(f.directory, 'cms', 'main'), null);
});

test('three-way promotion preserves independent target content and developer updates', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'CMS edit\n'); f.commit('Editor update');
  f.git('switch', 'main'); f.write(secondArticle, 'Independent publication\n');
  f.write('.github/workflows/validate-news.yml', 'new trusted validator\n'); f.commit('Developer update');
  const originalMain = f.git('rev-parse', 'main');
  const candidate = prepareCandidate(f.directory, 'cms', 'main');
  assert.equal(f.git('show', `${candidate.candidateSha}:${article}`), 'CMS edit');
  assert.equal(f.git('show', `${candidate.candidateSha}:${secondArticle}`), 'Independent publication');
  assert.equal(f.git('show', `${candidate.candidateSha}:.github/workflows/validate-news.yml`), 'new trusted validator');
  assert.equal(f.git('rev-parse', 'main'), originalMain, 'preparation must never update published refs');
});

test('conflicting edits leave main and cms unchanged', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'CMS conflict\n'); const source = f.commit('Editor conflict');
  f.git('switch', 'main'); f.write(article, 'Published conflict\n'); const target = f.commit('Other publication');
  assert.throws(() => prepareCandidate(f.directory, 'cms', 'main'), error => /Cannot safely combine/.test(error.message) && error.message.includes(article));
  assert.equal(f.git('rev-parse', 'main'), target);
  assert.equal(f.git('rev-parse', 'cms'), source);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('published corrections sync to the editor before its next edit and promotion', async t => {
  const f = remoteFixture(t);
  f.write(article, 'Correct official institution\n\nOriginal closing\n');
  const published = f.commit('Published correction'); f.git('push', 'origin', 'main');
  const synced = await syncIntake(f.directory, 'main');
  assert.equal(synced.candidateSha, published, 'idle CMS fast-forwards to the actual published head');
  assert.equal(f.remoteHead('cms'), published);
  f.git('switch', 'cms'); f.git('merge', '--ff-only', 'origin/cms');
  f.write(article, 'Correct official institution\n\nNew editorial closing\n');
  f.commit('Next CMS edit'); f.git('push', 'origin', 'cms');
  const next = prepareCandidate(f.directory, 'cms', 'main');
  assert.equal(f.git('show', `${next.candidateSha}:${article}`), 'Correct official institution\n\nNew editorial closing');
  f.git('switch', 'main'); f.git('merge', '--no-ff', '--no-edit', next.candidateSha); f.git('push', 'origin', 'main');
  const publishedMerge = f.remoteHead('main');
  const secondSync = await syncIntake(f.directory, 'main');
  assert.equal(secondSync.candidateSha, publishedMerge);
  f.git('switch', 'cms'); f.git('merge', '--ff-only', 'origin/cms');
  f.write(article, 'Correct official institution\n\nThird editorial closing\n'); f.commit('Third CMS edit');
  const third = prepareCandidate(f.directory, 'cms', 'main');
  assert.equal(f.git('show', `${third.candidateSha}:${article}`), 'Correct official institution\n\nThird editorial closing');
});

test('intake synchronization preserves a saved pending draft and reviewed maintenance', async t => {
  const f = remoteFixture(t);
  f.git('switch', 'cms'); f.write(secondArticle, 'status: draft\nPending translation\n');
  const draft = f.commit('Save unfinished draft'); f.git('push', 'origin', 'cms');
  f.git('switch', 'main'); f.write(article, 'Published correction\n');
  f.write('.github/workflows/validate-news.yml', 'new reviewed validator\n');
  const published = f.commit('Reviewed publication and maintenance'); f.git('push', 'origin', 'main');
  const synced = await syncIntake(f.directory, 'main');
  assert.equal(f.git('show', `${synced.candidateSha}:${secondArticle}`), 'status: draft\nPending translation');
  assert.equal(f.git('show', `${synced.candidateSha}:${article}`), 'Published correction');
  assert.equal(f.git('show', `${synced.candidateSha}:.github/workflows/validate-news.yml`), 'new reviewed validator');
  f.git('merge-base', '--is-ancestor', draft, synced.candidateSha);
  f.git('merge-base', '--is-ancestor', published, synced.candidateSha);
  assert.doesNotThrow(() => assertIntakeBoundary(f.directory, 'cms', { intake: synced.candidateSha, published }));
  assert.equal(f.remoteHead('main'), published, 'sync never promotes the pending draft');
});

test('same-file conflicts report paths and preserve both saved branches', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'Saved draft wording\n'); const intake = f.commit('Saved draft');
  f.git('switch', 'main'); f.write(article, 'Published correction\n'); const published = f.commit('Correction');
  assert.throws(() => prepareIntakeSync(f.directory, 'main', 'cms'), error => error.message.includes(article) && /saved CMS content is unchanged/.test(error.message));
  assert.equal(f.git('rev-parse', 'cms'), intake);
  assert.equal(f.git('rev-parse', 'main'), published);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('same-tree synchronization still records the actual published merge ancestry', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'Already saved\n'); f.commit('Editor save');
  const publication = prepareCandidate(f.directory, 'cms', 'main');
  f.git('switch', 'main'); f.git('merge', '--no-ff', '--no-edit', publication.candidateSha);
  const publishedMerge = f.git('rev-parse', 'main');
  const synced = prepareIntakeSync(f.directory, 'main', 'cms');
  assert.equal(synced.candidateSha, publishedMerge, 'sync uses the final published merge, not the pre-merge candidate');
  f.git('merge-base', '--is-ancestor', publishedMerge, synced.candidateSha);
  f.git('branch', '-f', 'cms', synced.candidateSha);
  assert.equal(prepareCandidate(f.directory, 'cms', 'main'), null, 'sync creates no recursive publication');
  assert.equal(prepareIntakeSync(f.directory, 'main', 'cms'), null);
});

test('divergent histories with identical files still merge the published ancestry into CMS', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.git('commit', '--allow-empty', '-m', 'CMS history'); const intake = f.git('rev-parse', 'HEAD');
  f.git('switch', 'main'); f.git('commit', '--allow-empty', '-m', 'Published history'); const published = f.git('rev-parse', 'HEAD');
  const synced = prepareIntakeSync(f.directory, 'main', 'cms');
  assert.ok(synced);
  f.git('merge-base', '--is-ancestor', published, synced.candidateSha);
  f.git('merge-base', '--is-ancestor', intake, synced.candidateSha);
  assert.equal(f.git('rev-parse', `${synced.candidateSha}^{tree}`), f.git('rev-parse', `${published}^{tree}`));
});

test('CMS validation accepts inherited trusted maintenance but rejects editor workflow edits', t => {
  const f = fixture(t);
  f.write('.github/workflows/validate-news.yml', 'reviewed main update\n'); const published = f.commit('Reviewed maintenance');
  f.git('switch', 'cms'); f.git('merge', '--no-ff', '--no-edit', 'main');
  f.write(article, 'CMS-only wording\n'); f.commit('Editor save after sync');
  assert.doesNotThrow(() => assertIntakeBoundary(f.directory, 'cms'));
  f.write('.github/workflows/validate-news.yml', 'untrusted CMS workflow\n'); f.commit('Editor code edit');
  assert.throws(() => assertIntakeBoundary(f.directory, 'cms'), /outside News content/);
  assert.equal(f.git('rev-parse', 'main'), published);
});

for (const [published, intake] of [['main', 'cms'], ['test', 'cms-test']]) {
  test(`${intake} validation uses published ancestry with both old and updated workflow context`, async t => {
    const f = remoteFixture(t);
    const before = f.remoteHead(intake);
    f.git('switch', published);
    f.write('.github/workflows/validate-news.yml', 'reviewed published maintenance\n'); f.commit('Reviewed maintenance'); f.git('push', 'origin', published);
    await syncIntake(f.directory, published);
    const run = (context = {}) => execFileSync(process.execPath, [fileURLToPath(new URL('./news-promotion.ts', import.meta.url)), 'boundary', f.directory], {
      env: { ...process.env, BASE_SHA: before, CMS_INTAKE_BRANCH: '', ALLOW_MAINTENANCE: 'false', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: intake, ...context }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.ok(run().includes(`boundary passed against published ${published}`), 'old workflow native context must work without the new flag');
    assert.ok(run({ CMS_INTAKE_BRANCH: intake }).includes(`boundary passed against published ${published}`));
    f.edit(intake, article, 'Saved article after synchronization\n');
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'news-old-workflow-'));
    t.after(() => fs.rmSync(shallow, { recursive: true, force: true }));
    f.git('clone', '--depth=1', '--branch', intake, pathToFileURL(f.git('remote', 'get-url', 'origin')).href, shallow);
    assert.match(execFileSync(process.execPath, [fileURLToPath(new URL('./news-promotion.ts', import.meta.url)), 'boundary', shallow], {
      env: { ...process.env, BASE_SHA: before, CMS_INTAKE_BRANCH: '', ALLOW_MAINTENANCE: 'false', GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: intake }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }), /boundary passed against published/u, 'old depth-one workflow checkout must load the mapped ancestry');
    assert.throws(() => run({ CMS_INTAKE_BRANCH: intake === 'cms' ? 'cms-test' : 'cms' }), /Invalid CMS intake branch/u);
    assert.throws(() => run({ GITHUB_REF_NAME: '__proto__' }), /Invalid News push branch/u);
    assert.throws(() => run({ CMS_INTAKE_BRANCH: 'constructor' }), /Invalid CMS intake branch/u);
    f.write('.github/workflows/validate-news.yml', 'untrusted editor maintenance\n'); f.commit('CMS workflow tamper');
    assert.throws(() => run(), /outside News content/u);
    assert.throws(() => run({ CMS_INTAKE_BRANCH: intake }), /outside News content/u);
  });
}

test('a concurrent CMS save rejects the normal push and survives refetch and remerge', async t => {
  const f = remoteFixture(t);
  f.write(article, 'Published correction\n'); const published = f.commit('Correction'); f.git('push', 'origin', 'main');
  let saved;
  const synced = await syncIntake(f.directory, 'main', { beforePush: (_candidate, attempt) => {
    if (attempt === 0) saved = f.edit('cms', secondArticle, 'Concurrent saved draft\n');
  } });
  assert.equal(f.git('show', `${synced.candidateSha}:${secondArticle}`), 'Concurrent saved draft');
  f.git('merge-base', '--is-ancestor', saved, synced.candidateSha);
  f.git('merge-base', '--is-ancestor', published, synced.candidateSha);
  assert.equal(f.remoteHead('cms'), synced.candidateSha);
});

test('a published head changing during sync is fetched again before success is reported', async t => {
  const f = remoteFixture(t);
  f.write(article, 'First published correction\n'); f.commit('Correction'); f.git('push', 'origin', 'main');
  let latest;
  const synced = await syncIntake(f.directory, 'main', { beforePush: (_candidate, attempt) => {
    if (attempt === 0) latest = f.edit('main', secondArticle, 'Latest published wording\n');
  } });
  assert.equal(synced.publishedSha, latest);
  assert.equal(f.git('show', `${synced.candidateSha}:${secondArticle}`), 'Latest published wording');
  f.git('merge-base', '--is-ancestor', latest, synced.candidateSha);
});

test('repeated editor writes stop bounded retries without replacing any saved commit', async t => {
  const f = remoteFixture(t);
  f.write(article, 'Published correction\n'); f.commit('Correction'); f.git('push', 'origin', 'main');
  let latest;
  await assert.rejects(syncIntake(f.directory, 'main', { beforePush: (_candidate, attempt) => {
    latest = f.edit('cms', secondArticle, `Saved draft ${attempt}\n`);
  } }), /heads kept changing/);
  assert.equal(f.remoteHead('cms'), latest);
  f.git('fetch', 'origin', 'cms');
  assert.equal(f.git('show', `${latest}:${secondArticle}`), 'Saved draft 2');
  assert.equal(f.git('status', '--porcelain'), '');
});

test('test synchronization cannot change production intake or accept another route', async t => {
  const f = remoteFixture(t);
  const production = f.remoteHead('cms');
  f.git('switch', 'test'); f.write(article, 'Test correction\n'); const published = f.commit('Test publication'); f.git('push', 'origin', 'test');
  const synced = await syncIntake(f.directory, 'test');
  assert.equal(synced.candidateSha, published);
  assert.equal(f.remoteHead('cms-test'), published);
  assert.equal(f.remoteHead('cms'), production);
  assert.throws(() => prepareIntakeSync(f.directory, 'main', 'cms-test'), /Invalid intake sync route/);
  await assert.rejects(syncIntake(f.directory, 'cms'), /Invalid published branch/);
  await assert.rejects(syncIntake(f.directory, '__proto__'), /Invalid published branch/);
  assert.throws(() => assertIntakeBoundary(f.directory, 'constructor'), /Invalid CMS intake/);
});

test('workflow sync covers token-created publications and human pushes using trusted main tools', () => {
  const workflow = fs.readFileSync(new URL('./workflows/promote-news.yml', import.meta.url), 'utf8');
  const syncJob = workflow.slice(workflow.indexOf('\n  sync:'));
  assert.match(workflow.split('\n').find(line => line.startsWith('run-name:')), /head_branch == 'test' \|\| github.ref_name == 'test'/u, 'test synchronization must keep its test label');
  assert.match(workflow, /push:\n    branches: \[main, test\]/u);
  assert.match(workflow, /branches: \[cms, cms-test, main, test\]/u, 'default-main workflow_run must cover published test even before its workflow file is upgraded');
  assert.match(workflow, /github.event_name != 'push' && github.ref == 'refs\/heads\/main'/u);
  assert.equal((workflow.match(/github.event.workflow_run.head_branch == 'cms' \|\| github.event.workflow_run.head_branch == 'cms-test'/gu) ?? []).length, 2, 'published-branch validation must not select or run CMS promotion');
  assert.match(syncJob, /github.event_name == 'push' && \(github.ref == 'refs\/heads\/main' \|\| github.ref == 'refs\/heads\/test'\)/u);
  assert.match(syncJob, /github.event_name == 'workflow_run'.*github.event.workflow_run.conclusion == 'success'.*github.event.workflow_run.head_branch == 'main' \|\| github.event.workflow_run.head_branch == 'test'/u);
  assert.match(syncJob, /github.event.workflow_run.event == 'push'/u, 'a validated PR with a same-named fork branch must not be treated as a published push');
  assert.match(syncJob, /ref: main\n          path: automation\n          persist-credentials: false/u);
  assert.match(workflow, /run: node automation\/\.github\/news-promotion.ts sync news '\$\{\{ matrix.target \}\}'/u, 'explicit sync must run in the publication job even when GITHUB_TOKEN suppresses push events');
  assert.match(syncJob, /group: publish-cms-news-\$\{\{ github.event.workflow_run.head_branch \|\| github.ref_name \}\}/u);
  assert.match(syncJob, /PUBLISHED_BRANCH: \$\{\{ github.event.workflow_run.head_branch \|\| github.ref_name \}\}/u);
  const validation = fs.readFileSync(new URL('./workflows/validate-news.yml', import.meta.url), 'utf8');
  assert.match(validation, /fetch-depth: 0/u);
  assert.match(validation, /CMS_INTAKE_BRANCH:.*github.event_name == 'push'.*github.ref_name == 'cms'.*github.ref_name == 'cms-test'/u);
  assert.match(validation, /run: node --test automation\/\.github\/news-promotion.test.ts/u);
});

test('CMS cannot promote workflow edits, even alongside valid content', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'Valid edit\n');
  f.write('.github/workflows/validate-news.yml', 'untrusted workflow\n'); f.commit('Tampered workflow');
  assert.throws(() => prepareCandidate(f.directory, 'cms', 'main'), /outside News content/);
});

test('symlinks and executable content cannot enter the published tree', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); fs.unlinkSync(path.join(f.directory, article));
  fs.symlinkSync('/etc/passwd', path.join(f.directory, article)); f.commit('Symlink');
  assert.throws(() => prepareCandidate(f.directory, 'cms', 'main'), /regular non-executable/);
});

test('test CMS is isolated from production', t => {
  const f = fixture(t);
  f.git('switch', 'cms-test'); f.write(article, 'Test-only copy\n'); f.commit('Test edit');
  const production = f.git('rev-parse', 'main');
  const candidate = prepareCandidate(f.directory, 'cms-test', 'test');
  assert.equal(candidate.target, 'test');
  assert.equal(f.git('rev-parse', 'main'), production);
  assert.throws(() => prepareCandidate(f.directory, 'cms-test', 'main'), /Invalid publication route/);
});

test('later CMS commits survive a previously pinned candidate', t => {
  const f = fixture(t);
  f.git('switch', 'cms'); f.write(article, 'First saved edit\n'); f.commit('First save');
  const first = prepareCandidate(f.directory, 'cms', 'main');
  f.git('switch', 'cms'); f.write(article, 'Second saved edit\n'); const later = f.commit('Second save');
  f.git('branch', '-f', 'main', first.candidateSha);
  const second = prepareCandidate(f.directory, 'cms', 'main');
  assert.equal(second.sourceSha, later);
  assert.equal(f.git('show', `${second.candidateSha}:${article}`), 'Second saved edit');
  assert.equal(f.git('rev-parse', 'cms'), later);
});

test('target advances require validation again, not a stale automatic merge', () => {
  assert.throws(() => assertCurrentTarget({ target: 'main', targetSha: 'before' }, 'after'), /changed during validation/);
});

test('reviewed automation maintenance is allowed only outside CMS promotion', t => {
  const f = fixture(t); const before = f.git('rev-parse', 'HEAD');
  f.write('.github/CODEOWNERS', '/.github/ @pyconhk/pycon-hk-website-team\n'); const after = f.commit('Maintain automation');
  assert.doesNotThrow(() => assertBoundary(f.directory, before, after, true));
  assert.throws(() => assertBoundary(f.directory, before, after), /outside News content/);
  assert.equal(isNewsFile('website/outstatic/content/2025-posts/story.ko.mdx'), false);
  assert.equal(isNewsFile('website/public/outstatic/images/logo.svg'), false);
});

test('immediate deployment callback is target scoped and fails closed without configuration', async t => {
  const { dispatchWebsite } = await import('./news-promotion.ts');
  const oldUrl = process.env.RECONCILER_URL;
  const oldToken = process.env.RECONCILER_TOKEN;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.RECONCILER_URL; else process.env.RECONCILER_URL = oldUrl;
    if (oldToken === undefined) delete process.env.RECONCILER_TOKEN; else process.env.RECONCILER_TOKEN = oldToken;
  });
  delete process.env.RECONCILER_TOKEN;
  await assert.rejects(dispatchWebsite('test', 'run-1'), /requires/);
  await assert.rejects(dispatchWebsite('cms', 'run-1'), /Invalid website/);
  process.env.RECONCILER_URL = 'https://pyconhk-content-reconciler.example.workers.dev';
  process.env.RECONCILER_TOKEN = 'fixture-only';
  const calls = [];
  await dispatchWebsite('production', 'run-1', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response('checked');
  });
  assert.deepEqual(calls, [{ url: `${process.env.RECONCILER_URL}/deploy`, body: { target: 'production', id: 'run-1' } }]);
  await assert.rejects(dispatchWebsite('test', 'run-2', async () => new Response(null, { status: 503 })), /callback failed/);
});
