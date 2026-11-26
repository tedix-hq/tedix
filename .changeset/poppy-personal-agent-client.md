---
"@tedix/cli": patch
---

Add `tedix poppy`, the Personal Agent side of Poppy 1.0: publish a client metadata document and JWKS for a locally held ES256 key, discover a company's `/.well-known/poppy.json`, and call its listed endpoints with a signed `Poppy-Session` request as one of three clearly named simulated agent identities (`--unsigned` sends the same request without Poppy headers).
