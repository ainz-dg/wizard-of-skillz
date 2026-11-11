# Security policy

Wizard of Skillz is a pre-release project and does not yet promise a security-response SLA.

Do not include credentials, proprietary code or vulnerability details in public issues. The repository and experimental prereleases are public. Maintainers should enable and verify GitHub **Security → Advisories** private vulnerability reporting; this document does not claim that private reporting is already enabled. Do not disclose security-sensitive details in public issues. No verified alternative private reporting channel, reporting address or response SLA is currently announced.

The default scan is offline and read-only. Optional LLM actions may transmit selected source excerpts to configured providers. Review remote endpoints and avoid plaintext HTTP with bearer credentials. Model output is untrusted data, never permission to write. Apply has separate human confirmation, hash/path checks, backups and best-effort rollback, but concurrent changes and filesystem races remain residual risks.
