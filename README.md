# PyCon HK News content

Business and marketing editors use the News CMS. Its production editor commits
directly to `cms`; the separate test editor commits to `cms-test`. Saving a
complete published article starts automatic validation and publication. Editors
do not need to request a GitHub review or merge a pull request.

Drafts are public in this repository. Articles with `status: draft` remain hidden
on the website. A published 2026 article requires all six locales; 2025 retains
its five locales.

| Editor | Intake branch | Validated branch | Website |
| --- | --- | --- | --- |
| Production CMS | `cms` | `main` | `https://pycon.hk` |
| Test CMS | `cms-test` | `test` | `https://pyconhk-website-test.pages.dev` |

## Automatic publication

`Validate News content` runs when an editor saves. Its successful completion
starts `Publish CMS News`, using trusted automation from the default `main`
branch. A five-minute schedule and **Run workflow** on `main` provide fallback
and manual recovery. GitHub can delay scheduled runs.

The publisher pins the intake and destination commits, checks the News-only
change boundary, combines them without discarding existing changes, and runs
the matching website's locale, frontmatter, image and Astro build checks. It then
creates an audit PR, records `News Content` on the exact validated commit and
merges it automatically. No per-article human approval is required. PRs created
by `GITHUB_TOKEN` do not start another PR workflow, so the publisher explicitly
records the validation it has already performed.

Conflicts, failed validation, changed destination branches and non-content edits
stop publication without changing the published branch. Later CMS commits are
left intact for the next run. The intake branches are never force-pushed or
reset. Test intake can only publish to `test`; production intake only to `main`.

The website repository detects the validated News `main` and `test` snapshots on
its existing five-minute deployment schedule, pins their commit SHAs, and builds
only when inputs changed. Website deployment remains in GitHub Actions, using
the website repository's Cloudflare credentials. This News repository needs no
Cloudflare secrets or cross-repository deployment token. Confirm publication
using the public website's deployment manifest and exact News commit, rather
than treating a successful News check as proof of website deployment.

## Access and branch setup

- Give `@pyconhk/pycon-hk-marketing-team` **Write on this News repository only**.
  Developers keep website source, CMS implementation and deployment access.
- Seed `cms` from `main` and `cms-test` from `test`, once. Configure production
  and test CMS to use these branches with Decap's simple publishing mode.
- Protect `main` and `test`: require a PR, require the strict **News Content**
  check from GitHub Actions, and block force pushes and deletion. Set required
  approvals to zero and disable latest-push approval. Require code-owner review:
  `/.github/` belongs to `@pyconhk/pycon-hk-website-team`; News files have no
  code-owner requirement. This protects automation changes while allowing
  automatic content publication.
- Allow GitHub Actions to create pull requests. The publication job explicitly
  requests only contents-write, pull-requests-write and checks-write. Validation
  jobs use contents-read and no deployment secrets.
- Keep `cms` and `cms-test` writable by CMS editors. They are intake branches,
  not deployment sources. Their code or workflow changes cannot be promoted.

Developers propose automation changes through a reviewed PR. The validation
workflow permits only the explicitly listed maintenance files in addition to
News data. During initial installation, an owner can review the feature branch
and manually dispatch its `Validate News content` workflow to produce the
required check before the new automation exists on the protected base branch.

## Content paths and local checks

Posts retain their original paths under
`website/outstatic/content/{2025,2026}-posts/`; raster uploads remain under
`website/public/outstatic/images/`. Symlinks, executable files, remote covers,
missing covers and incomplete published translations are rejected.

Run the publication safeguards with Node.js 24:

```sh
node --test .github/news-promotion.test.ts
```

The tests cover conflict preservation, independent destination changes, intake
isolation, later CMS commits, protected file rejection and already-published
snapshots. Full content and website build validation runs in GitHub Actions.

Original import: `pyconhk/pyconhk-website` main commit
`91a93d42b425b691bfc0f7f51b0334e2e60702ec`. Existing archive content, URLs and
image bytes are retained.
