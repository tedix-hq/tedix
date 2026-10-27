---
"@tedix/cli": patch
"@tedix/api": patch
"@tedix/api-contract": patch
---

`tedix logout` now revokes the stored sign-in at the authorization server before removing the local login, and warns when it cannot. The Descope AIH drift audit reports each resource's token lifetimes and flags wildcard client-metadata domain policies.
