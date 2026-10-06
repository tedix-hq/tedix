# Tedix Artifact Gateway

The artifact gateway is the public, cookie-isolated byte boundary for content
authored by agents. It accepts only `GET`/`HEAD` requests on the signed artifact
and skill-media routes plus the authority-free `GET /health` deployment proof,
removes ambient browser and Tedix authority headers, and streams the API
service-binding response without buffering it.

The API remains the authority for URL signatures, organization checks, object
lookup, response MIME type, and sandbox CSP. This Worker intentionally has no
session endpoint, RPC route, storage binding, or secret.

Production is served from a dedicated `workers.dev` origin outside the
authenticated Tedix cookie sites. Keeping agent-authored bytes on
a separate origin prevents those documents from sharing product cookies or
product-origin browser authority. See the public
[Cloudflare architecture](../../docs/public/cloudflare-architecture.md)
for the surrounding Worker and storage boundaries.

Only that production `workers.dev` route is public. Wrangler Preview URLs are
explicitly disabled: artifact signatures are host-independent, so leaving old
version hosts routable would let historical gateway code keep calling the
production API service binding after the active version had been repaired.
