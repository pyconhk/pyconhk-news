import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBoundary, assertCurrentTarget, isNewsFile, prepareCandidate } from './news-promotion.ts';

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
  assert.throws(() => prepareCandidate(f.directory, 'cms', 'main'), /Cannot safely combine/);
  assert.equal(f.git('rev-parse', 'main'), target);
  assert.equal(f.git('rev-parse', 'cms'), source);
  assert.equal(f.git('status', '--porcelain'), '');
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
