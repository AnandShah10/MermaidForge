# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's private reporting: **Security → Report a vulnerability** on [the repository](https://github.com/AnandShah10/mermaidforge/security/advisories/new). Include the version, steps to reproduce and the impact.

You can expect an acknowledgement and a fix or a mitigation plan as soon as the maintainer can manage; this is a volunteer project, so there is no guaranteed response time.

## Supported versions

Only the latest published version receives fixes.

## What the extension does with sensitive data

- API keys are stored in VS Code `SecretStorage` only — never in settings or logs.
- AI requests contain the current diagram's Mermaid source (if `mermaidForge.ai.sendSourceContext` is on) and locally computed lint/complexity summaries. No workspace file is sent by any shipped command.
- No telemetry.
- Diagram webviews use a strict Content-Security-Policy (nonce-gated scripts, no remote scripts, `securityLevel: strict` for Mermaid).
- Comments are stored locally in `.mermaidforge/comments.json`.
