# Impact Map: repo shape R-C — T-1, standalone rhize-tasks runtime repo (2026-09-03)

Scoped copy, for this repository's own refactor-gate receipt, of the **T** extraction
described in the marketplace plan `rhize-plugins/.claude/plans/repo-shape-r-c.md`. That plan
is authoritative; this file exists only because the gate requires the impact map to live
inside the workspace it governs. The **M** (skill-monitor) extraction in the source plan is
out of scope here.

## Current behavior and evidence

Before this change, `rhize-tasks/` existed only as a subdirectory inside the `rhize-plugins`
marketplace monorepo. `installer/install.mjs` resolves the service tree relative to its own
file (`installerDir`), so it already runs correctly from any checkout, but direct execution
always performs a full install — there is no `--check` flag, and `main()` calls `install()`
unconditionally. `installer/safe-paths.mjs` defines the installer's own staging/sweep target
under `~/Library/Application Support/Rhize Tasks/runtime`. `doctor` (`service/src/api/
context.mjs`) reports installed-runtime-version equality against the running package version,
but records no source ref/commit and computes no drift. `installation.json` (written by
`install()`) does not carry `sourceRef`/`sourceCommit` fields today.

## Intended semantic delta

1. Split `rhize-tasks/`'s history into this standalone repository (`Rhize-Media/rhize-tasks`,
   private for now) via `git subtree split`, with a cleanup commit removing the plugin-only
   files (`commands/`, `skills/`, `.claude-plugin/`, `.codex-plugin/`, `setup/`, `GUIDE.md`,
   `CHANGELOG.md`) and a rewritten runtime-focused README top section.
2. `installer/install.mjs` gains a `--check` flag: runs only non-mutating readiness checks
   (platform, Node version, Swift/Xcode toolchain, codesign availability, loopback port,
   existing-installation summary), prints an install plan, writes nothing under `runtime/` or
   Application Support, and exits 0 when ready / 1 with the first blocking reason otherwise.
3. `install()` records `sourceRef` (git tag or branch of the source checkout) and
   `sourceCommit` (`git rev-parse HEAD`) into `installation.json` when the source directory is
   a git checkout, else both `null`.
4. `service/src/api/context.mjs`'s `doctor()` surfaces `sourceRef`/`sourceCommit` from the
   installed manifest, and computes a `sourceDrift` boolean when the CLI is invoked with
   `--expect-source-ref <tag>` and the installed ref differs.
5. Tag `v0.5.0` on the cleanup+installer commit; `package.json` version bumped to `0.5.0` in
   that same commit.

## Invariants and must-not-change boundaries

No force-push; nothing deleted on GitHub; the installer's transactional install/rollback
semantics, Keychain-only secret storage, bundle id, and LaunchAgent labels are unchanged;
`runtime/` is never a `--check` write target; existing `validatePrerequisites()` callers
(tests, `install()`) keep the same signature and behavior; no edit is made to
`rhize-plugins` or `rhize-plugins-r-a` (both in use by other sessions) — the only monorepo
operation is a read-only `git subtree split`.

## Acceptance tests

`node --test` passes in this repository; `node installer/install.mjs --check` exits 0 or 1
with a legible reason and writes nothing new under `~/Library/Application Support/Rhize
Tasks/` (verified by an `ls` snapshot before/after); new tests cover `--check` (no writes,
correct exit codes) and the `sourceRef`/`sourceCommit`/`sourceDrift` provenance fields using
the existing `createTestPathPolicy` temp-HOME test policy; the sanitizer scan (secret shapes,
personal identifiers, internal hostnames) is run and reported before any visibility change;
tag `v0.5.0` exists on the cleanup+installer commit.

## File-level touchpoints (this repository only)

Removed (cleanup commit): `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `GUIDE.md`,
`commands/doctor.md`, `commands/preferences.md`, `commands/reconcile.md`,
`commands/review-opportunities.md`, `commands/setup.md`, `commands/today.md`,
`setup/manifest.json`, and every `skills/*/SKILL.md` plus its sibling `skills/*/agents/
openai.yaml` (`manage-task-preferences`, `plan-my-day`, `reconcile-rhize-tasks`,
`review-task-opportunities`, `rhize-tasks-doctor`, `rhize-tasks-setup`).
Modified (cleanup commit): `README.md` (top section rewritten per "Intended semantic delta"
item 1), `package.json` (the `validate` script's now-deleted `setup/manifest.json` check
removed — an orphan created directly by this cleanup), `tests/e2e/dashboard.test.mjs` (its
"shared skills and Claude commands preserve the local planning boundary" test removed — it
asserted content of the `skills/`/`commands/` files this commit deletes, and has no remaining
subject matter in this repository; the runtime-facing dashboard tests in the same file are kept
unchanged).
Modified (installer commit): `installer/install.mjs` (`--check`, `sourceRef`/`sourceCommit`),
`service/src/api/context.mjs` (`doctor()` provenance/`sourceDrift`), `service/bin/
rhize-tasks.mjs` (`doctor --expect-source-ref`), `tests/connectors/reminders-process.test.mjs`
and/or a new installer test file (coverage for `--check` and provenance), `package.json`
(version bump to `0.5.0`).

## Implementation order

1. Cleanup commit: remove plugin-only files, rewrite README top section.
2. Installer commit: `--check` in `install.mjs`, `sourceRef`/`sourceCommit` in
   `installation.json`, `doctor`/`sourceDrift` in `context.mjs` and the CLI's
   `--expect-source-ref` flag in `service/bin/rhize-tasks.mjs`, plus new tests.
3. Verify (`node --test`, `--check` on this machine, before/after `ls` snapshot).
4. Sanitizer scan, reported (visibility flip stays Jim's decision).
5. Tag `v0.5.0` and push.
