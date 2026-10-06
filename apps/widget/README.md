# @tedix/widget

Framework-neutral white-label Tedi widgets for customer applications.

Production assets are served from `https://widget.tedix.dev`. New integrations
install the small asynchronous `/v1/loader.js`; it queues lifecycle calls while
the full `/v1/embed.js` runtime downloads. Exact immutable loader and runtime
paths plus their Subresource Integrity hashes are published in
`/v1/manifest.json`, together with the SDK version, exact build SHA, release
timestamp, and minimum bootstrap version. Direct `/embed.js` remains the stable
current-major runtime alias. The script executes inside the host page and
obtains a short-lived signed session from its same-origin `/r/tedi/session`
route.

Hosted MCP Apps resource documents live in `apps/mcp-ui` at
`https://mcp-ui.tedix.dev`. Embedded tool projections may frame those sandboxed
resources, but this Worker does not render them. Both json-render
`ui.create_view()` results and scriptless free-form `ui.create_mcp_app()`
results use the same validated `ui://widgets/mcp-app/<app>/r/<layout>.html`
projection contract. The embedded host passes only bounded structured result
data and the current light/dark theme to `mcp-ui.tedix.dev`; it never injects
model-authored HTML into the host page and the framed generated document keeps
its capability-free inner sandbox.

Conversation transcript providers should return `{ role, content, metadata }`
for each message. Assistant metadata is optional, but including the canonical
bounded Home-message metadata lets MCP UI projections survive conversation
switches and reloads instead of existing only during the live tool stream.

## Installation

```html
<script
	async
	src="https://widget.tedix.dev/v1/loader.js"
	data-tedix-tenant="customer-slug"
	data-tedix-preload="open"
></script>
```

`open` is the recommended preload policy: the launcher mounts immediately, the
runtime downloads with it, and the signed session is requested only after
interaction. `eager` additionally requests the session as soon as the runtime
boots, and `idle` requests it when the browser next goes idle — both trade a
little bootstrap work for a faster first answer. Every mode downloads the
runtime at init; the loader used to act only on `open`, which left the other
two inert. Opening or preloading the widget does not run a business query.

The host supplies authenticated, same-origin POST routes at `/r/tedi/session`
and `/r/tedi/identify`, derives identity from its own session, and keeps the
provider API key server-side. Session responses use `Cache-Control: no-store`;
access denials must remain access denials rather than transient errors.

The host CSP must permit `https://widget.tedix.dev` in `script-src`,
`https://api.tedix.dev`, `https://*.tedi.tedix.dev` and
`wss://*.tedi.tedix.dev` in `connect-src`, and `https://mcp-ui.tedix.dev`
in `frame-src`. Permit `data:` and configured artwork origins in `img-src`.
Keep same-origin requests allowed for session exchange and identification.

For strict change control, read `/v1/manifest.json` during the host's build and
pin `loaderPath` with `loaderIntegrity`, or pin `path` with `integrity` when the
host does not need the queueing bootstrap. Mutable aliases use `no-cache`
so clients revalidate; content-addressed paths cache immutably for one year.

## Browser SDK

Calls made through the loader before runtime readiness are queued and replayed:

```js
Tedix.boot({ consent: { functional: true, personalization: true } });
Tedix.update({ context: { pathname: "/m/orders" } });
Tedix.open();
await Tedix.ask("Resume las órdenes pendientes");
const capabilityState = await Tedix.capabilities();
await Tedix.attachCapability(capabilityState.available[0].id, "order_review");
await Tedix.detachCapability(capabilityState.attached[0].id);
await Tedix.deleteConversation(conversationId);
Tedix.close();
Tedix.shutdown();
```

`ask()`, `capabilities()`, `attachCapability()`, `detachCapability()`, and
`deleteConversation()` return promises even while the runtime is
still downloading. `ask()` waits out a conversation restore in flight rather
than dropping the message, and rejects with a code when it cannot send:
`turn_in_progress` when a turn is already running, `conversation_loading` while
history is still arriving, `conversation_unavailable` when the conversation
could not be loaded. It never resolves with an empty string in place of an
error. Those promises settle with the eventual runtime call and
reject with `code: "runtime_load_failed"` if the runtime cannot load; they never
report optimistic success from the bootstrap queue. Calling `shutdown()` while
the runtime is downloading rejects them with `code: "widget_shutdown"`, clears
all queued identity/context state, and cancels the pending runtime script.

## Published branding

Name, wording, colors, launcher artwork, starter prompts and locale come from
the provider console, not from host code. At mount the runtime reads
`https://api.tedix.dev/widget/branding/{tenant}` — a public, edge-cached
presentation allowlist that never carries audience policy, capacity or the
portable tool profile — and applies it to the launcher and the panel.

An explicit boot option or `data-tedix-*` attribute always wins over published
branding; published branding wins over the runtime defaults. A slow or failing
branding request mounts the widget unbranded rather than not at all. Point the
lookup elsewhere with `data-tedix-api-origin` (local development), or pass
`branding: false` to opt out entirely.

The same response carries the widget's copy catalog for the visitor's language,
so no string is compiled into the runtime as English-or-Spanish. Copy lives in
`packages/widget-i18n` (English is the source; Spanish and German ship today).
A tenant may
override an individual key from its console.

Hosts must allow `https://api.tedix.dev` in `connect-src`.

## Declared routes

Page context is data, not host code. Declare the routes that mean something to
the assistant and the runtime evaluates them on every SPA navigation — a
`pushState`, a `replaceState`, and back/forward — so no host router effect
computes context:

```js
Tedix.boot({
	routes: [
		{ match: "/app/orders", routeKey: "orders" },
		{
			match: "/app/orders/:orderId",
			routeKey: "order-detail",
			title: "Order :orderId",
			entity: { type: "order", id: ":orderId", label: "Order #:orderId" },
		},
		{ match: "/app/settings/*", routeKey: "settings" },
	],
});
```

The same rules may travel on the script tag as `data-tedix-routes` JSON, which
keeps a scriptless host declarative. `:name` captures one URL-decoded segment; a
trailing `*` matches the path and everything under it; rules are evaluated in
order, so a literal route may precede its own pattern. `title`, `entity` and
`params` values interpolate captures, and a template naming an uncaptured param
drops that field rather than emitting the raw token. At most 64 rules compile.

An explicit `Tedix.context({…})` call still wins, and `shutdown()` unbinds the
navigation listener and restores the patched history methods. Route context is
untrusted input: it improves the answer and selects a portable tool projection,
and never widens authority.

The public lifecycle is `boot`/`init`, `update`, `context`, `consent`, `track`,
`open`, `close`, `ask`, `capabilities`, `attachCapability`, `detachCapability`,
`artifactPins`, `pinArtifactRevision`, `detachArtifactPin`,
`deleteConversation`, `identify`, `status`, `diagnose`, `on`, `off`, and `shutdown`. Hosts
must call `shutdown()` before an authenticated user
changes or logs out. It aborts active requests, disposes Cap'n Web clients and
WebMCP registrations, disconnects observers/listeners, and removes the Shadow
DOM host.

Named capabilities are scoped to the current signed widget conversation. The
runtime revalidates the token's tenant, origin, host user, and opaque
conversation session key on every list, attach, and detach call. Returned
entries include why-present provenance and always report
`authority: "context_only"`; attaching one does not grant tools, MCP scopes,
connections, policy, or fine-grained authorization (FGA) access.

Artifact pins use the same signed conversation boundary. Call
`Tedix.pinArtifactRevision(artifactId, replayName)` only with an artifact
published by the current tedi in the current embedded conversation. The server
accepts only platform-owned single-file R2 artifacts with a recorded SHA-256,
snapshots that revision, and revalidates it on every read. A changed source is
reported stale and excluded from turn context. The pin never grants artifact
read access, tools, MCP scopes, policy, or FGA authority.

Conversation deletion is host-authorized rather than a direct browser
capability. Supply `options.deleteConversation` when mounting:

```js
Tedix.init({
	tenant: "customer-slug",
	deleteConversation: ({ conversationId }) =>
		api.kernelRuntime.deleteConversation({ conversationId }),
});
```

`Tedix.deleteConversation(conversationId)` calls this provider before disposing
the local embedded client or removing the history item. If the provider is not
configured, the call fails explicitly. The provider must invoke Tedix's
canonical hard-delete contract: it cancels active parent and child Home runs,
purges conversation-owned runtime state, and retains only a content-free
tombstone plus a separate audit receipt. Accepted Work Items and child-tedi
ledgers are retained. This contract does not promise deletion of
content-addressed attachment blobs from R2, because other durable records may
still reference the same blob.

Consent defaults to functional and personalized operation with analytics off:

```js
Tedix.consent({
	functional: true,
	personalization: true,
	analytics: false,
});
```

Functional consent controls signed-session access. Personalization and analytics
preferences remain part of the host consent state; they do not trigger background
business queries. The widget uses generic conversation transport and configured
MCP capabilities with signed user/organization context. It has no built-in
order reader, automatic attention card, or attention-outcome producer.
An admitted conversation may use the configured order tools normally.

Lifecycle events are available through `Tedix.on(name, callback)` and DOM
events named `tedix:<name>`: `loaded`, `ready`, `opened`, `closed`, `consent`,
`session-refreshed`, `performance`, `shutdown`, and `error`. The local-only
`performance` event reports bounded `ready` and signed-session durations and
outcomes without tenant, actor, page, conversation, message, or endpoint data;
hosts decide whether to forward it and must honor their own analytics consent.
Runtime-load failures likewise expose only a failure phase and duration, never
the asset URL. `Tedix.status()` reports SDK
version, mount/session state, transport, preload policy, effective consent, and
WebMCP registration plus the latest content-free reliability snapshot.
`await Tedix.diagnose()` performs an explicit installation probe covering the
tenant, same-origin endpoint, signed session, Cap'n Web transport, and WebMCP
host availability; unlike passive `status()`, the probe may request a session.

## Authenticated contact profiles

Configure `identifyEndpoint: "/r/tedi/identify"` in `Tedix.boot`, or put
`data-tedix-identify-endpoint="/r/tedi/identify"` on the loader script. Boot
identifies before mounting; `await Tedix.identify()` refreshes the profile.
The endpoint must be same-origin and accept authenticated POST requests.
The SDK sends no caller-selected identity or profile body.

The host endpoint derives the current user, business, and role from its own
session and calls `identifyEmbeddedProviderContact` with `externalTenantId`,
`hostUserId`, optional `hostRole`, and `profile`:

```js
{
  user: { name: "Daniel", email: "daniel@example.com",
          customAttributes: { language: "es" } },
  company: { name: "Example Garage", customAttributes: { plan: "business" } }
}
```

Return the API's `{ installationId, user, company }` result. Attributes are
bounded scalar values; omitted fields preserve stored values, explicit null
clears a field, and null attribute values delete individual keys. These
profiles are display data and never grant permissions. Keep identity and
reserved authorization fields outside custom attributes.

Identification does not mint a chat session or consume inference capacity.
Hosts should also identify recognized users before checking widget availability,
so disabled audiences remain visible in the provider's directory even when no
widget is mounted. Availability and signed-session authorization still decide
whether a person may chat. A changed identity returned by `identify()` clears
the mounted conversation before remounting. Call `shutdown()` immediately on
logout or before changing the authenticated account; it also cancels pending
identification, preventing late responses from remounting the old account.
