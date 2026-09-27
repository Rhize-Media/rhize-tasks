# CI parser major-update policy

## Current behavior and evidence
Base 4ce294886ef2e85db2f953f7845e4a4521ecc785. CI-only package .github/ci-tools pins TypeScript5.9.3 for the canonical AST scanner. Current Dependabot grouping does not prevent major update PRs. Direct API probe: TypeScript7.0.2 lacks createSourceFile and ScriptTarget, while5.9.3 supports the checker. Historical HTTP400 errors at PR creation remain unresolved; this is not a backend-error fix.

## Intended semantic delta
Hold only CI-only TypeScript semantic-major version updates until a reviewed parser migration. Continue weekly grouped minor/patch updates. For configurations combining application and CI directories, split into non-overlapping npm blocks so root application updates retain existing policy. Preserve schedule days and per-block limits.

## Invariants and must-not-change boundaries
No workflow jobs, source, lockfiles, helper bytes, dependency versions, tests, provider calls, credentials, repository settings, original checkouts or proof branches change. No executor commit/push. Historical error evidence remains unresolved.

## Planned additions and structural touchpoints
Modify .github/dependabot.yml and README.md. Add this local child plan only. No deletions. Existing CI version pin and README describe the compiler-API constraint.

## External and operational effects
Local source configuration only. Parent handles independent review and later approved publication; normal scheduled Dependabot behavior changes only after publication. No rerun requested.

## Acceptance tests
Parse YAML and assert each original directory appears exactly once, every schedule stays weekly and preserves day, existing Actions policy unchanged, only CI-only TypeScript majors are ignored, application/root ignore policy unchanged, grouped minor/patch updates retained. Verify diff has no runtime/lock/helper paths. No full suite rerun for this configuration-only change. Reconcile child map.

## Explicitly unaffected paths
.github/workflows/, .github/ci/, .github/ci-tools/, source, tests, package manifests/locks, runtime settings, original checkout.

## Unknowns and confidence
Generic HTTP400 does not prove a path restriction or permissions cause. This policy avoids known incompatible parser upgrades; hosted updater creation behavior remains unproven. CodeGraph absent; scoped reads used.

## Implementation order
Prepare; minimal config/documentation patch; focused YAML assertions and diff checks; reconcile; parent reviewer and publication.
