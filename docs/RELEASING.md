# Releasing Wizard of Skillz

**Human-controlled release, automated verification and npm publication.** This
is the public, generic Wizard project: it is independent of any organization's
private Agent Skills catalog.

## Current status

- Last verified publication when RC6 preparation started: **`0.5.0-rc.5`** (November 11, 2026).
- GitHub: [v0.5.0-rc.5](https://github.com/ainz-dg/wizard-of-skillz/releases/tag/v0.5.0-rc.5).
- **`0.5.0-rc.6` is a prepared candidate, not a confirmed npm publication.**
  It requires a separately approved release after the release-preparation PR
  passes CI and the dry-run archive is reviewed.
- npm dist-tag: `next`; the prerelease does **not** use `latest`.
- Install: `npx --yes wizard-of-skillz@next` (resolves to the latest **published**
  prerelease). Pin a specific published version for repeatable installations.
- The npm Trusted Publishing (OIDC) publish step succeeded. The release workflow
  [43036735181](https://github.com/ainz-dg/wizard-of-skillz/actions/runs/43036735181)
  is marked failed because its registry-visibility check ran before npm finished
  processing the package. A later independent registry check confirmed RC5 and
  `@next`, matching archive integrity, and clean installation from npm.
  **Do not republish RC5 or treat this as an unpublished release.**

## Future release flow

1. Prepare a reviewed PR for a **new, unused** package version and update the
   lockfile, user-facing installation docs, and release notes. Run CI.
2. Merge only after explicit owner approval. Merging to `main` never publishes.
3. Run **Wizard approved release -> npm** on branch `main` via
   `workflow_dispatch`, with `release_tag` equal to `v<package-version>`
   and `expected_commit` equal to the exact current 40-character `main` SHA.
   This is a dry-run: it cannot publish.
4. Inspect the successful dry-run's `wizard-release-<package-version>` artifact,
   including `release-archive.json`, tarball checksum and clean-install smoke.
5. Only with explicit owner approval, create the exact matching Git tag and
   publish a **GitHub prerelease** pointing to the same `main` commit.
   A draft is insufficient: the trigger is `release.published`.
6. The existing `.github/workflows/release.yml` must verify the precise commit,
   build the archive, publish via npm Trusted Publishing (OIDC), and verify the
   npm shasum/integrity and clean installation from the registry. The registry
   may take minutes to make a newly published version visible; distinguish a
   delayed verification check from a publish failure using logs and read-only
   registry evidence. Do **not** retry `npm publish` blindly.
7. Confirm that the intended `next` tag resolves to the new prerelease and
   that a clean `npx` invocation works before announcing it as installable.

## Publishing guardrails

- The release workflow has `id-token: write` **only** for its npm publish job;
  there are no stored npm publication tokens or authorized bypasses.
- npm Trusted Publishing must remain configured for owner `ainz-dg`,
  repository `wizard-of-skillz`, workflow `release.yml`, with direct publishing
  enabled and no GitHub environment (unless the workflow is deliberately updated).
- STOP for unexpected `main` HEAD, tag mismatch, draft/stable release, failed
  tests or package checks, invalid artifact, mismatched registry identity or
  unavailable npm authorization. Never force-push, retag an existing release,
  or attempt to republish an immutable npm version.
- A successful offline scan or clean installation does not verify model output
  quality or real-account availability of experimental providers.
- Owner approval is required separately for merge and publication.

## Historical note

The first npm publication (`0.5.0-rc.3`) used one-time manual initialization.
The first verified OIDC publication was `0.5.0-rc.4`. Neither bootstrap flow
should be repeated for a new release.

See [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/).
