# Spott security and supply-chain gate policy

Updated: 2026-07-17 (Asia/Tokyo)

This policy defines the repository-owned security gate. It does not authorize deployment, credential use, external messaging, package publication, or production mutation.

## Required pull-request behavior

- The required job runs fork-safe with top-level `contents: read`, no environment, no repository/environment secrets, no `pull_request_target`, no restored cache, and checkout credentials disabled.
- The gate verifies the exact toolchain lock, workflow policy, generated and migration provenance, full Git-history/current-tree credential scan, frozen dependency installation, dependency audit at `high` severity or above, and sanitized evidence integrity.
- A scanner, audit, build, or policy failure determines the job result. Artifact upload cannot convert failure into success.
- Required execution must not contain inline ignores, `continue-on-error`, swallowed exit codes, mutable action tags, live browser downloads, deployment, release, publication, provider-send, purchase, refund, or cloud-mutation commands.

## Credential scanning and evidence

- `scripts/ci/scan-repository-secrets.mjs` scans the current tracked tree and every reachable commit for reviewed private-key, AWS, GitHub, Stripe-live, and Slack token forms.
- Reports contain only schema version, status, commit count, allowlisted count, hashed fingerprints, repository paths, and pattern classes. Matching credential bytes and environment values are never written to stdout, stderr, or reports.
- Uploaded reports and status artifacts are regular, non-symlink, non-group/world-writable files covered byte-for-byte by a sorted SHA-256 manifest.
- Built API, Worker, Web, and Ops outputs and source maps must receive an equivalent credential/configuration scan before the security workflow can be called repository-ready. That artifact scanner is still an open implementation item.

## Exceptions

- The default allowlist is empty.
- An exception is a separately reviewed repository change containing exactly one finding fingerprint, a specific reason, and a canonical expiry no more than 90 days away.
- Expired, malformed, duplicate, overly long, or no-longer-matching exceptions fail the gate. A broad path, pattern, environment, branch, actor, or inline-code suppression is invalid.
- An exception acknowledges only the exact scanner fingerprint. It does not waive dependency, authorization, privacy, encryption, runtime, or provider evidence.

## Remediation and ownership

- A leaked credential is revoked and rotated outside this repository by an explicitly authorized operator before code remediation is considered complete. No gate script prints or reuses it.
- The feature owner repairs the source; a trusted non-author reviewer approves credential, workflow, allowlist, and policy changes. The actual trusted GitHub identity remains externally unresolved and is never invented in CODEOWNERS.
- Critical and high dependency findings block required checks. Lower-severity findings require a tracked remediation decision before release evidence is signed off; they are not hidden by command-line suppression.
- Workflow/action/tool pins, scanner policy, allowlist, migration provenance, and evidence verifiers are transitive protected inputs and must be covered by effective base-branch CODEOWNERS before external protection can be activated.

## Trusted push-only reporting

A separate `push`-to-`main` workflow may upload sanitized SARIF with only `contents: read` and `security-events: write`. It must not execute pull-request code with a write token, must not use repository secrets, and is never one of the seven required pull-request checks. No reporting workflow may create issues or contact external systems.
