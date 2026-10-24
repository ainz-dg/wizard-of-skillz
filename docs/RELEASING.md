# Release checklist (maintainer)

This is a **preparation checklist**, not automation or permission to publish. Wizard is a personal, provider-agnostic project. Do not import company-specific files or historical Git history into the public repository.

## 1. Verify exact candidate

- Record the release candidate commit SHA. Test that precise checkout on Node 22 (>=22.12) and 24, on Linux and ideally macOS.
- Run `npm ci --no-audit --no-fund`, `npm test`, `npm run pack:check`, `node bin/wizard.mjs --version`, and `node bin/wizard.mjs --help`.
- On a disposable synthetic repository, exercise local scan, review, proposal preparation, separate Apply confirmation, stale-hash checks, symlinks/path traversal, CREATE/UPDATE/MOVE/REMOVE, backup and failure rollback.
- Verify the TUI interactively via a PTY at 120×30, 100×24, 90×20, 80×16 and 60×12. Include no-color fallback and confirmation/navigation.
- Inspect the complete `npm pack --dry-run --json` file list, then make a real tarball locally and install it in a **disposable** location. Validate the installed `wizard` executable. Ensure no secrets, historical corporate artifacts, fixture/internal audit files or unintended test data appear in the tarball.
- Audit the new repository's complete Git history, license/attribution, Copilot SDK dependencies and remote provider handling. In particular, verify any source-derived Matt Pocock wording against its MIT terms.
- Confirm that GitHub private vulnerability reporting is actually enabled, or establish another verified private security contact. Do not claim an unsupported SLA.

GitHub Actions jobs that terminate without steps do not count as test results. Do not infer a PASS from previous repositories.

## 2. Prepare npm and GitHub

- Verify `wizard-of-skillz` is still available **directly against the npm registry**; a search result or missing public page alone is insufficient.
- Choose the exact public prerelease version and Git tag; current proposal: `0.5.0-rc.2` with npm tag `next`.
- Preserve the source/package GitHub URL and confirm public README, licence and acknowledgements agree.
- The candidate intentionally has `private: true`. **Only after testing, the maintainer's explicit approval and npm account verification**, remove that field on a dedicated publishable commit and re-test/re-inspect the exact commit/tarball.
- If using npm trusted publishing, configure it in npm with the exact GitHub workflow and use a public GitHub-hosted Actions run. As of October 2026, it requires npm CLI >=11.5.1 and Node >=22.14; the existing CI must first run successfully. See <https://docs.npmjs.com/trusted-publishers/>.
- Otherwise a maintainer may choose a directly authenticated manual publish, subject to npm account security and explicit authorization. Do not store persistent npm tokens in the repo.

## 3. Final human approval (separate from code review)

After all checks pass, ask the maintainer to authorize **each** operation: merging reviewed PR(s), changing GitHub repository visibility, creating the Git tag/GitHub Release and publishing on npm. None of these actions are performed by this checklist. Public npm publication is not reversible in the same way as a Git branch.

For a maintainer-authorized manual prerelease only, the intended npm command is:

```sh
npm publish --access public --tag next
```

Do **not** run this command on a private, unverified or unapproved candidate. Afterwards verify the published package version, registry metadata, dist-tag and `npx wizard-of-skillz@next --version` from a clean environment.
