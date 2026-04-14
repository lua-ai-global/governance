# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.9.x   | ✅        |
| < 0.9   | ❌        |

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Please report security issues by emailing **security@heylua.ai** with:

- Description of the vulnerability
- Steps to reproduce
- Affected versions
- Impact assessment (if known)

## What to Expect

- **Acknowledgment** within 48 hours
- **Assessment** within 5 business days
- **Fix timeline** communicated after assessment

## Scope

The following are considered security issues:

- Injection detection bypasses
- Audit trail integrity vulnerabilities (hash chain tampering)
- Policy enforcement bypasses
- Kill switch circumvention
- Authentication/authorization issues in remote enforcement

The following are **not** security issues:

- Injection detection false positives/negatives for edge cases (report as a regular issue)
- Performance degradation under extreme input sizes
- Issues in peer dependency frameworks

## Responsible Disclosure

We ask that you give us reasonable time to address vulnerabilities before public disclosure. We will credit reporters in release notes (unless you prefer anonymity).
