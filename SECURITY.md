# Security Policy

## Supported Versions

Security fixes are applied to the latest published release. Pre-release builds are provided for evaluation and must not be exposed directly to the public internet.

## Reporting A Vulnerability

Use the repository's private GitHub Security Advisory form. If that channel is unavailable, email [info@right-api.com](mailto:info@right-api.com) with the subject `Security report: RightAPI Forge`. Do not open a public issue or send ordinary support mail containing exploit details, credentials, customer data, or private infrastructure information.

Include the affected version, reproduction steps, impact, and any suggested mitigation. Maintainers will acknowledge a report as soon as practical and coordinate disclosure after a fix is available.

## Deployment Expectations

- Generate unique installation secrets; no default credentials are provided.
- Keep the application behind authenticated network access until the deployment has been hardened.
- Mount Docker and SSH access only when required and scope credentials to the minimum necessary permissions.
- Require approval for destructive actions and retain execution audit records.
- Keep recovery encryption keys under custody separate from the source host.
