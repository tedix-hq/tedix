# Tedi console sessions

The first version uses the tedi's existing Descope identity (option **a**).
`packages/auth/src/tedi-identity.ts` already provisions a Descope user and a
user-bound access key per tedi, so option **b** would duplicate that identity.
No Descope role, JWT template, user, or flow change is required for this path.

An active human organization owner or admin opens **Team → tedi → Settings →
Console access**, selects Workspaces, and enables **Allow console access
(read-only)**. The API checks fresh active membership and that the administrator
can open every selected Workspace. No tedi, external agent, API key, service
binding, or M2M client can grant this access. It defaults to disabled.

## Sign in

1. Exchange the existing user-bound tedi access key for its Descope JWT using
   the existing runtime exchange. Do not use a human session or `tedix login`.
2. Send `POST /tedix/session/tedi` on the configured session-broker auth origin,
   with `Authorization: Bearer <tedi Descope JWT>`. No body is needed. The
   broker relays only that bearer to the API over its binding. The API matches
   the authenticated tedi and Descope subject to the organization-owned row,
   checks the grant, and returns `{ sessionToken, expiresAt }`.
3. In the tedi's browser, send a same-origin `POST /tedi-console/session` on
   the chosen organization's OS hostname with
   `Authorization: Bearer <sessionToken>`. It validates the credential and host,
   installs `__Host-tedix-tedi-console` (HttpOnly, Secure, SameSite=Strict), and
   redirects to `/tedi-console`. Browser automation can perform this POST with
   a same-origin fetch, then navigate to `/tedi-console`. Never put either
   credential in a URL, saved script, audit metadata, or log.

The minimal console shows the tedi's own identity, selected Workspace names and
descriptions, and their Output titles and kinds. It does not load the human
console shell or expose Output bodies, connectors, collaboration, or execution.
The separate cookie is never translated into a human Descope session.

## Enforcement

Sessions last at most five minutes and never outlive the input Descope JWT.
They carry a dedicated issuer, audience, token type, organization, tedi, and grant
revision. The API derives a domain-separated signing key from its existing
master key using HKDF; neither the broker nor OS receives that key.

Only `tediConsole.read` accepts this credential. Its authentication runs before
service-binding trust, so forwarded admin headers cannot broaden it. All other
API procedures reject it; the Descope validators also reject its distinct token
format. The API reloads the grant and active tedi on every read, binds any OS
tenant header to the signed organization, and checks the requested Workspace
against the grant. Any saved grant change invalidates outstanding sessions,
including disabling and re-enabling access. There is no refresh token.

Session creation and every successful read write audit events with
`actorType=tedi` and the tedi's ID. Grants are audited as the human administrator.
The session cannot write, run, approve, or self-grant. Changes continue through
the existing governed Work/approval execution path under the tedi's identity;
an approval does not upgrade a console session into a write credential.

## Installation steps

Managed operators must release the generated `tedi_console_grants` migration,
API, session broker, and OS through their installation's guarded workflow.
The broker now requires an `API_SERVICE` binding to the API's
`InternalEntrypoint`; checked-in names remain examples. The API uses its existing
`SECRETS_MASTER_KEY`. No live configuration was changed by the source work.
After release, a human administrator enables the setting and chooses Workspaces.
Verify one own-identity read, its tedi audit row, a denied write, a denied
unselected Workspace, and denial of an outstanding session after revocation.
