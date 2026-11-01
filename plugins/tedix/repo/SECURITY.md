# Security Policy

This repository holds the published Tedix plugin: skills, manifests and the
address of the Tedix gateway. It contains no server code and no credentials.
It is generated from [tedix-hq/tedix](https://github.com/tedix-hq/tedix);
a fix lands there first.

## Reporting a Vulnerability

Please do **not** report security vulnerabilities in public GitHub issues.

Report privately through GitHub private vulnerability reporting (the
repository's Security tab → "Report a vulnerability") or by email to
[security@tedix.dev](mailto:security@tedix.dev). We aim to acknowledge private
reports within three business days.

Relevant here:

- a skill or manifest that instructs an agent to act beyond the access a
  person granted, or to treat fetched content as instructions
- a manifest pointing anywhere other than the Tedix gateway
- anything in this tree that looks like a credential

For the gateway and product itself, see the
[Tedix security policy](https://github.com/tedix-hq/tedix/blob/main/SECURITY.md).
