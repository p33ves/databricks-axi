# Security Policy

## Supported Versions

Only the latest published version is supported for security fixes.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities. Use
[GitHub private vulnerability reporting](https://github.com/p33ves/databricks-axi/security/advisories/new)
and include the affected version, reproduction steps, expected impact, and any
safe proof-of-concept details.

## Design notes for reporters

- databricks-axi holds no credentials; auth is fully delegated to the official
  `databricks` CLI.
- Child processes are spawned with array argv (never a shell).
- Secret values are stdin-only, never accepted as flags, never echoed.
- REST passthrough bodies never land on child argv (visible in `ps`):
  inline bodies are written to a private (0600) temp file and passed as
  `--json @path`, deleted after the call.
- Error and job log output redact token-shaped strings.
