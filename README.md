# PyCon HK News content

This repository is for public editorial News content. Drafts and review branches are visible publicly; do not put embargoed or private information in them.

The `test` branch is for review and the `main` branch is for approved publication. Branches start from the same imported snapshot. Branch protection, CMS access, website integration, and deployments are not configured by this local seed.

News posts retain their website paths under `website/outstatic/content/2025-posts/` and, when created, `website/outstatic/content/2026-posts/`. Uploaded images retain their paths under `website/public/outstatic/images/`. Legacy Outstatic media metadata is not needed by Decap.

Import source: `pyconhk/pyconhk-website` branch `main`, commit `91a93d42b425b691bfc0f7f51b0334e2e60702ec`. All 30 localized posts preserve that production snapshot, including its working 2025 archive links. Cover images use the equivalent local `/outstatic/images/` URLs instead of the retired Outstatic API URLs. The six image files are byte-identical to the source.

## Owner setup before connecting Decap

1. Create the public `pyconhk/pyconhk-news` repository and push this seed to both `test` and `main`. Give business/marketing editors **Write on this News repository only**; keep website code and deployment permissions with developers. Public drafts are intentional.
2. Protect `test` and `main` with rulesets requiring pull requests, at least one independent review, and the **News Content** status check from `Validate News content`. Block force pushes and branch deletion. Decap editorial PRs must be reviewed before merge. CMS test targets `test`; production targets `main`.
3. The check rejects any future PR/push that changes files outside localized `2025-posts`/`2026-posts` MDX or raster files in `website/public/outstatic/images`. It also rejects symlinks, incomplete published locale sets, remote cover URLs, and missing local cover images. The locale validator and Astro build come from the corresponding `pyconhk/pyconhk-website` `test` or `main` branch and run on an overlay of this repository's content; the build also catches malformed frontmatter used by the site. Workflow or policy edits need an owner-admin ruleset bypass and separate review.
4. Keep website deployment credentials and the Cloudflare account in the website repository. The website build should pin a News commit SHA for each environment, overlay its content, and record that SHA in its deployment manifest.

## Publishing and access

- Business/marketing editors need **Write** on this content repository only. Developers retain website code, GitHub Actions deployment secrets, and Cloudflare access. This seed does not assign individual users or teams.
- Both protected branches require one independent approval and the **News Content** check. Dismiss stale reviews when new commits arrive and require approval of the latest push. Keep force pushes and deletion disabled; reserve any policy-maintenance bypass for repository administrators.
- CMS test writes editorial PRs targeting `test`; production writes editorial PRs targeting `main`. Test and production use different collection IDs so their draft branches cannot collide. An editor can also propose a reviewed `test` → `main` promotion in GitHub.
- The website repository owns deployment. With `NEWS_SOURCE=external` enabled, its existing scheduled workflow checks both content branches every five minutes, pins the selected News commit, and only builds when inputs changed. GitHub scheduling may be delayed. An authorized website developer can run **Deploy Website** manually for immediate verification. This content repository needs no Cloudflare credentials or cross-repository dispatch token.
- To confirm publication, check the website deployment manifest for this repository, the intended `test` or `main` ref, and the exact merged News commit SHA; a successful News validation alone is not a website deployment.
