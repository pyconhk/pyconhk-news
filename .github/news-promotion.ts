import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const routes = { cms: 'main', 'cms-test': 'test' };
const repository = 'pyconhk/pyconhk-news';
const maintenanceFiles = new Set([
  'README.md', '.github/CODEOWNERS', '.github/news-promotion.ts',
  '.github/news-promotion.test.ts', '.github/actions/validate-news/action.yml',
  '.github/workflows/validate-news.yml', '.github/workflows/promote-news.yml',
]);

export function isNewsFile(file) {
  return /^website\/outstatic\/content\/2025-posts\/[^/]+\.(en|zh-hk|zh-hant|zh-hans|ja)\.mdx$/u.test(file)
    || /^website\/outstatic\/content\/2026-posts\/[^/]+\.(en|zh-hk|zh-hant|zh-hans|ja|ko)\.mdx$/u.test(file)
    || /^website\/public\/outstatic\/images\/[^/]+\.(png|jpg|jpeg|webp|gif|avif)$/u.test(file);
}

function git(directory, args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function ancestor(directory, older, newer) {
  try { git(directory, ['merge-base', '--is-ancestor', older, newer]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

function changedFiles(directory, base, head) {
  return git(directory, ['diff', '--no-renames', '--name-only', '-z', base, head]).split('\0').filter(Boolean);
}

export function assertBoundary(directory, base, head, allowMaintenance = false) {
  const allowed = file => isNewsFile(file) || (allowMaintenance && maintenanceFiles.has(file));
  const invalid = changedFiles(directory, base, head).filter(file => !allowed(file));
  if (invalid.length) throw new Error(`Changes outside News content: ${invalid.join(', ')}`);
  for (const entry of git(directory, ['ls-tree', '-r', '-z', head]).split('\0').filter(Boolean)) {
    const [metadata, file] = entry.split('\t');
    const [mode] = metadata.split(' ');
    if (!isNewsFile(file) && !maintenanceFiles.has(file)) throw new Error(`Unexpected tracked file: ${file}`);
    if (mode !== '100644') throw new Error(`Only regular non-executable files may be published: ${file}`);
  }
}

export function prepareCandidate(directory, source, target, refs = { source, target }) {
  if (routes[source] !== target) throw new Error(`Invalid publication route: ${source} → ${target}`);
  const sourceSha = git(directory, ['rev-parse', refs.source]);
  const targetSha = git(directory, ['rev-parse', refs.target]);
  if (ancestor(directory, sourceSha, targetSha)) return null;
  const base = git(directory, ['merge-base', targetSha, sourceSha]);
  assertBoundary(directory, base, sourceSha);
  git(directory, ['checkout', '--detach', targetSha]);
  try {
    git(directory, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'merge', '--no-ff', '--no-commit', sourceSha]);
    if (!git(directory, ['diff', '--cached', '--name-only'])) {
      git(directory, ['merge', '--abort']);
      return null;
    }
    git(directory, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '-m', `Promote ${source} News (${sourceSha.slice(0, 7)})`]);
  } catch (error) {
    try { git(directory, ['merge', '--abort']); } catch { /* No merge remains after a completed commit. */ }
    throw new Error(`Cannot safely combine ${source} with ${target}; published content is unchanged. ${error.stderr || error.message}`);
  }
  const candidateSha = git(directory, ['rev-parse', 'HEAD']);
  assertBoundary(directory, targetSha, candidateSha);
  return { source, target, sourceSha, targetSha, candidateSha };
}

async function api(endpoint, method = 'GET', body) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required for automatic publication');
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(`GitHub ${method} ${endpoint}: ${response.status} ${data.message || ''}`), { status: response.status });
  return data;
}

async function readRemoteRef(ref) {
  try { return (await api(`git/ref/heads/${ref}`)).object.sha; }
  catch (error) { if (error.status === 404) return null; throw error; }
}

export function assertCurrentTarget(candidate, actualSha) {
  if (actualSha !== candidate.targetSha) throw new Error(`${candidate.target} changed during validation; the next run will rebuild the candidate.`);
}

async function publishCandidate(directory, candidate) {
  if (routes[candidate.source] !== candidate.target) throw new Error('Invalid publication route');
  if (git(directory, ['rev-parse', 'HEAD']) !== candidate.candidateSha || git(directory, ['status', '--porcelain'])) {
    throw new Error('Validated candidate working tree changed');
  }
  assertBoundary(directory, candidate.targetSha, candidate.candidateSha);
  assertCurrentTarget(candidate, await readRemoteRef(candidate.target));
  const branch = `automation/${candidate.source}-to-${candidate.target}`;
  const previousHead = await readRemoteRef(branch);
  // The credential helper reads GH_TOKEN from the environment; never put it in a URL or arguments.
  git(directory, ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', `--force-with-lease=refs/heads/${branch}:${previousHead || ''}`, 'origin', `${candidate.candidateSha}:refs/heads/${branch}`]);
  const head = `pyconhk:${branch}`;
  const matches = await api(`pulls?state=open&base=${candidate.target}&head=${encodeURIComponent(head)}`);
  const description = {
    title: `Publish ${candidate.source} News to ${candidate.target}`,
    body: `Automatically publishes validated CMS content.\n\nSource: \`${candidate.sourceSha}\`\nTarget before validation: \`${candidate.targetSha}\`\nValidated candidate: \`${candidate.candidateSha}\`\n\nChecks: News-only changes, regular local files, locale completeness, frontmatter, cover images and Astro build.\n\n[Publication run](${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID})`,
  };
  const pull = matches.length
    ? await api(`pulls/${matches[0].number}`, 'PATCH', description)
    : await api('pulls', 'POST', { ...description, head, base: candidate.target });
  // GITHUB_TOKEN-created PRs do not start another PR workflow. Record the checks
  // performed in this trusted run on the exact candidate commit instead.
  await api('check-runs', 'POST', {
    name: 'News Content', head_sha: candidate.candidateSha, status: 'completed', conclusion: 'success',
    completed_at: new Date().toISOString(),
    details_url: `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    output: { title: 'CMS News validated', summary: `Validated source ${candidate.sourceSha} against ${candidate.targetSha}; candidate ${candidate.candidateSha}.` },
  });
  for (let attempt = 0; attempt < 6; attempt++) {
    assertCurrentTarget(candidate, await readRemoteRef(candidate.target));
    try {
      const result = await api(`pulls/${pull.number}/merge`, 'PUT', { sha: candidate.candidateSha, merge_method: 'merge' });
      if (!result.merged) throw new Error(result.message || 'GitHub declined the merge');
      console.log(`Published ${candidate.sourceSha} via PR #${pull.number}; ${candidate.target} is ${result.sha}`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published **${candidate.source} → ${candidate.target}** via [PR #${pull.number}](${pull.html_url}).\n\nPublication succeeded. The next step requests immediate website reconciliation; the Worker repairs a missed handoff.\n`);
      return;
    } catch (error) {
      if (![405, 409].includes(error.status) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

export async function dispatchWebsite(environment, reconciliationId = '', dispatch = fetch) {
  if (!['production', 'test'].includes(environment)) throw new Error('Invalid website deployment target');
  const endpoint = process.env.RECONCILER_URL;
  const token = process.env.RECONCILER_TOKEN;
  if (!endpoint || !token) throw new Error('Immediate deployment requires RECONCILER_URL and RECONCILER_TOKEN');
  const url = new URL('/deploy', endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.workers.dev')) throw new Error('Use the configured HTTPS reconciler Worker');
  const response = await dispatch(url.href, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: environment, id: reconciliationId || `news-${process.env.GITHUB_RUN_ID}` }),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Immediate deployment callback failed: ${response.status}`);
}

async function main() {
  const [command, directoryArg, source, target] = process.argv.slice(2);
  const directory = path.resolve(directoryArg || 'news');
  const stateFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'news-publication.json');
  if (command === 'prepare') {
    if (routes[source] !== target) throw new Error('Unknown publication route');
    const available = git(directory, ['ls-remote', '--heads', 'origin', `refs/heads/${source}`]);
    if (!available) { console.log(`${source} is not configured; skipping.`); return; }
    git(directory, ['fetch', '--no-tags', 'origin', `+refs/heads/${source}:refs/remotes/origin/${source}`, `+refs/heads/${target}:refs/remotes/origin/${target}`]);
    const candidate = prepareCandidate(directory, source, target, { source: `origin/${source}`, target: `origin/${target}` });
    if (!candidate) { console.log(`${source} has no new News content.`); return; }
    fs.writeFileSync(stateFile, JSON.stringify(candidate));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
    console.log(`Prepared ${candidate.candidateSha} from ${candidate.sourceSha}`);
  } else if (command === 'publish') {
    await publishCandidate(directory, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
  } else if (command === 'deploy') {
    await dispatchWebsite(process.env.DEPLOYMENT_TARGET, process.env.RECONCILE_ID || '');
  } else if (command === 'boundary') {
    const head = 'HEAD';
    const base = /^[a-f0-9]{40}$/u.test(process.env.BASE_SHA || '') && !/^0{40}$/u.test(process.env.BASE_SHA || '')
      ? process.env.BASE_SHA : head;
    if (base !== head) git(directory, ['fetch', '--no-tags', '--depth=1', 'origin', base]);
    assertBoundary(directory, base, head, process.env.ALLOW_MAINTENANCE === 'true');
    console.log('News file boundary passed.');
  } else throw new Error('Expected prepare, publish or boundary');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
