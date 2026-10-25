# Releasing Wizard of Skillz

**Human-controlled release, automated verification and npm publication.**
This workflow is for the generic open-source Wizard project, not smeup's
private skill distribution or governance. Only the owner publishes releases.

## Current prerelease candidate — first OIDC publish

- Package: `wizard-of-skillz`
- Candidate: `0.5.0-rc.4`
- Release tag: `v0.5.0-rc.4`
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
3. Supply `release_tag = v0.5.0-rc.4` and the **full 40-character
   current main SHA** as `expected_commit`. Select branch `main`.
4. The dry-run checks package metadata, committed HEAD against current main,
   tests, package files, exact archive and a fresh tarball installation.
5. Download the workflow artifact named `wizard-release-0.5.0-rc.4`.
   It contains `wizard-of-skillz-0.5.0-rc.4.tgz` and `release-archive.json`.
   Inspect files and verify SHA-256 against the manifest. Do not publish without
   an explicit owner decision and completed source/security/manual TUI review.

**Dry-run does not call npm publish and cannot publish accidentally.**

## Historical one-time npm initialization (completed for rc.3)

`0.5.0-rc.3` was already created on npm and verified by the GitHub Release
workflow. The manual initialization documented below is **historical**: do not
repeat it for `0.5.0-rc.4`. The upcoming release must exercise OIDC publishing.

For reference, the first release used the exact verified tarball and the
owner's npm account with 2FA:


```sh
npm login
npm publish ./wizard-of-skillz-0.5.0-rc.3.tgz --access public --tag next
npm view wizard-of-skillz@0.5.0-rc.3 dist.integrity

```

This manual npm bootstrap is an exceptional owner action. It uses the same
verified archive, not a repackaged local tree. Do not request or store npm
passwords, OTPs, or write tokens in GitHub Actions.

The owner then published the `v0.5.0-rc.3` GitHub prerelease. The completed
workflow detected the matching npm archive, skipped duplicate publication and
verified integrity and clean installation. Mismatched archives fail closed.

For `rc.4`, the owner reports that **npm Trusted Publishing** has been configured.
Its first successful OIDC publish must occur within two days of configuration.
The actual permissions and identity will be validated by the release run.
Reconfirm Package Settings -> Trusted publishing -> GitHub Actions:
- Owner: `ainz-dg`
- Repository: `wizard-of-skillz`
- Workflow filename: `release.yml`
- Environment: leave empty (workflow does not declare one)
- **Allow direct npm publish**: enable explicitly. New publisher registrations
  grant staging by default, not direct publish.

For `rc.4`, repeat review / dry-run / Git tag / Pre-release publish. The GitHub
Release must cause a **real** npm publish via OIDC (the publish step must not
be skipped), and the verify job must confirm archive identity and a clean
registry install. After this succeeds, consider restricting token-based
publishing. Do not claim OIDC validation based only on a green `rc.3` run.

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
