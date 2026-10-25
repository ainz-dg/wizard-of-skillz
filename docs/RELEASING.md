# Releasing Wizard of Skillz

**Human-controlled release, automated verification and npm publication.**
This workflow is for the generic open-source Wizard project, not smeup's
private skill distribution or governance. Only the owner publishes releases.

## Current prerelease candidate

- Package: `wizard-of-skillz`
- Candidate: `0.5.0-rc.3`
- Release tag: `v0.5.0-rc.3`
- npm dist-tag: `next`; never `latest` for this prerelease
- Features: software skill reviews (existing), TUI-first project selection
  (new), documented-domain resource proposals (experimental), account-backed
  Codex/Claude Code CLI providers (experimental; require local real-account
  verification)
- PDF/DOCX resources, external source connectors, and automatic installation
  of proposed skills are NOT part of this candidate.

## Release flow

Code review and CI -> merge to main -> explicit owner decision -> verify
exact commit -> tag/Publish GitHub Release -> Actions release.yml -> npm via
Trusted Publishing (OIDC) -> registry integrity and clean-install smoke.

Merging or pushing to main NEVER publishes on npm. A draft GitHub Release
does not publish either. The trigger is **Release: published**, and the
published prerelease must point to the exact current main commit.

No stored npm publish tokens. `release.yml` grants
`id-token: write` to the npm publishing job only. No legacy 2FA
bypass, no force push, no republishing existing mismatched versions, no
automatic PR merges, and no private release repository dependencies.

## Verify the exact prepared commit (no publish)

1. Merge the reviewed release pipeline PR only when CI is green.
2. In GitHub Actions choose **Wizard approved release -> npm** > Run workflow.
3. Supply `release_tag = v0.5.0-rc.3` and the **full 40-character
   current main SHA** as `expected_commit`. Select branch `main`.
4. The dry-run checks package metadata, committed HEAD against current main,
   tests, package files, exact archive and a fresh tarball installation.
5. Download the workflow artifact named `wizard-release-0.5.0-rc.3`.
   It contains `wizard-of-skillz-0.5.0-rc.3.tgz` and `release-archive.json`.
   Inspect files and verify SHA-256 against the manifest. Do not publish without
   an explicit owner decision and completed source/security/manual TUI review.

**Dry-run does not call npm publish and cannot publish accidentally.**

## One-time npm initialization (new package only)

As of October 2026, npm does **not** allow configuring a Trusted Publisher on a
name that has not yet been created on the registry. Verify the name directly on
the registry and verify the account has publishing rights. If it is taken,
STOP and select a different name through a reviewed package change.

For the **first** release only, the owner downloads the exact tarball produced
by the green dry-run; on their own machine, with npm 2FA:


```sh
npm login
npm publish ./wizard-of-skillz-0.5.0-rc.3.tgz --access public --tag next
npm view wizard-of-skillz@0.5.0-rc.3 dist.integrity

```

This manual npm bootstrap is an exceptional owner action. It uses the same
verified archive, not a repackaged local tree. Do not request or store npm
passwords, OTPs, or write tokens in GitHub Actions.

After the bootstrap, the owner may publish GitHub Release
`v0.5.0-rc.3`, marked as **Pre-release** and using
`docs/releases/0.5.0-rc.3.md` as notes. The release
workflow detects the **identical** npm archive and skips the duplicate publish,
then verifies the npm registry shasum, integrity and CLI install. If the
existing archive is DIFFERENT, it fails closed.

Configure the first **npm Trusted Publisher** when the NEXT npm version is
ready to publish, so validation happens within npm's 2-day activation window.
Package Settings -> Trusted publishing -> GitHub Actions:
- Owner: `ainz-dg`
- Repository: `wizard-of-skillz`
- Workflow filename: `release.yml`
- Environment: leave empty (workflow does not declare one)
- **Allow direct npm publish**: enable explicitly. New publisher registrations
  grant staging by default, not direct publish.

For the next version, repeat review / dry-run / Git tag / Pre-release publish.
When the GitHub Release is published, GitHub Actions now publishes to npm via
OIDC, then verifies archive identity and an isolated install. Prefer
restricting token-based publishing after successful OIDC validation.

Docs: https://docs.npmjs.com/trusted-publishers/

## Stop conditions and limits

- Different main HEAD, missing/moved tag, draft or stable GitHub Release,
  unexpected repository, bad package version, failed regression test,
  suspicious archive content, unavailable npm registry, registry hash conflict:
  **STOP; no publish**.
- A successful offline test does not validate provider account login or the
  business correctness of generated domain skills; note these experimental
  limitations prominently in the GitHub Release.
- npm versions are immutable: changes after publication require a NEW version.
- The workflow does not create the GitHub Release. It requires the owner's
  explicit published-release action, preserving human governance.
