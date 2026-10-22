# Rhize Tasks state

## Verified facts

- PR #3 refreshes managed CI to published Infra e89aa676ac2865cb70f95693d000b0d902ec992a. It adds canonical repository identity validation, reviewed dynamic env families, cleanup-safe disposable state and regular SQL-only migration staging with symlink rejection.
- Current remote main 0ca59f0 is an ancestor of the PR head; no conflicts required resolution. Consumer CI now pins Node 24.22.1. Runtime Node >=22 compatibility and application/native code remain unchanged.

## General rules

- Canonical manifest hashes detect local drift. Verify upstream provenance independently against the recorded Infra Git blobs; preserve canonical bytes when changing consumer runtime configuration.
- This PR is authorized for local checks and merge only. GitHub Actions must not run: include [skip ci] in the pushed head and main merge subject, never dispatch a workflow. Future workflow policy remains unchanged.
- Fixture tests do not establish live Calendar/Reminders/Jira/Slack behavior or TCC/signing acceptance. A source merge does not install, activate or release the runtime.

## Open failures

- No unresolved check failure in the reviewed scope. The default CLT Swift invocation initially could not find its installed Testing.framework; all 16 native tests pass with the process-local framework/search-path command now documented in README. No test or assertion was disabled.

## Lessons learned

- A shell Node update does not replace an installed LaunchAgent's recorded executable path. Use the reviewed installer upgrade when the installed runtime needs replacement.

## Last session

- 2026-10-22: user authorized PR #3 review, documentation refresh, conflict resolution if needed and main merge after local checks. No GitHub CI/CD credits may be consumed.

- Local verification on Node 24.22.1, including the configured npm 11.6.2 without global installation: frozen parser install; managed configure/manifest/canonical Git-blob comparisons; environment documentation over 64 tracked sources; package validation; 341 application tests, 21 exact-revision canonical regression tests and 16 native Swift tests passed, with no skips. Read-only installer preflight reports ready=true. No application/native build or live installation was triggered beyond the existing Swift test build.
- Independent source/security/simplicity review found no blocking issue. YAML validation confirmed existing read-only permissions and push/PR-only automatic triggers; no runtime/native/test/dependency source changed. Published upstream main is already contained in the PR, so no conflict resolution or upstream merge was necessary.
- GitHub Actions and live connector/TCC/signing acceptance are intentionally untested. Exact pushed/merged SHA and zero-new-run evidence are retained in the private local review checkpoint after publication.
