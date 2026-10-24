# Security policy

Wizard of Skillz is a pre-release project and does not yet promise a security-response SLA.

Do not include credentials, proprietary code or vulnerability details in public issues. Before public release, maintainers must activate and verify GitHub **Security → Advisories** private vulnerability reporting. Until private reporting is verified, do not disclose security-sensitive details in public issues. Maintainers have not yet announced an alternative private contact. No reporting address or response SLA is claimed.

The default scan is offline and read-only. Optional LLM actions may transmit selected source excerpts to configured providers. Review remote endpoints and avoid plaintext HTTP with bearer credentials. Model output is untrusted data, never permission to write. Apply has separate human confirmation, hash/path checks, backups and best-effort rollback, but concurrent changes and filesystem races remain residual risks.
