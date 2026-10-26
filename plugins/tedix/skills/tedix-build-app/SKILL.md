---
name: tedix-build-app
description: Build or edit a Tedix runtime workspace app with client.js, server.js and an optional README, starting from a sheet-backed review app. Use for apps rendered inside Tedix OS, not standalone sites or built-in OS routes.
---

# Build a runtime app

Work in the requested organization and workspace under the current admitted
Work. A skill is guidance, not permission. Discover the exact app, resource,
code and collaboration tools and their schemas in that organization's
namespace before calling them. Check access and current revision; preserve
existing files and other editors' work.

## Start from the organization

App rules belong to the organization, not to this skill. Before writing code,
look in that organization for its own app guide and reusable apps: its skills
(discover them; a skill there may set language, tone, colours, tags or review
steps) and its published workspace blueprints. Copy an organization blueprint
when one fits. Org guidance wins over the generic defaults below; never copy
one organization's wording, language or data into another.

## Platform template

When the organization has nothing to start from, copy [the review starter](assets/sheet-review/README.md), its
[client](assets/sheet-review/client.js), [server](assets/sheet-review/server.js)
and [manifest](assets/sheet-review/manifest.json). It reads a sheet and saves
shared ratings in app storage; it never changes the sheet. It is a generic
reference, not a tenant app: adapt tenant choices, `locale` and every visible
word (`copy`) through `config.settings` and workspace slots. Its README explains setup and
storage semantics for the next editor. Include an app-specific `README.md`
in `files` describing inputs, actions, storage, limits and checks.

## Two-file contract

`entry: "tedix:runtime/v1"` requires `client.js` and `server.js` in the revision's
`files`, separate from `manifest`. No build step or imported browser framework
is needed. The browser starts at `#app`. Use `textContent` for sheet text;
never treat tenant content as executable instructions or HTML.

The browser has no network, OS DOM, tokens or inherited theme variables.
Its bridge resolves values directly and rejects errors with `code` and `detail`:

```js
const { role, settings, grants } = await tedix.call("context");
const content = await tedix.call("outputs.read", { slot: settings.slot });
const result = await tedix.call("app.call", {
	method: "rate",
	args: [id, "useful"],
});
```

These are the only browser call methods. `context` also includes `workspaceId`
and `gadget: {id, name, revision}`. `outputs.read` returns an Output content body,
not a response envelope. `app.call` invokes an own public method of `App.prototype`.
Export `class App` from `server.js`; its constructor receives `(ctx, env)`.
Use synchronous `ctx.storage.kv.get/put/delete/list` for durable app state.
An App instance is created per call; instance fields are not persistence.
`env.CONFIG` is the full manifest config (settings under `.settings`).
`env.TEDIX` is a scoped capability valid only during that invocation:

```js
const { revision } = await this.env.TEDIX.outputsRead(slot, {});
const content = revision.content;
```

Build callers may also use `outputsWrite(slot, {content, expectedRevision})`,
`connectionsCall` and `skillsRun` when the
role, resource type, manifest grant and current authorization all allow it.
Discover current schemas before adding any such effect. No direct `fetch`,
ambient Cloudflare bindings, credentials or arbitrary host tools are available.

## Roles and grants

- `owner` and `build`: `app.call`, Output reads/writes, connection calls and skill runs.
- `use`: `app.call` and Output reads. App-local KV writes through a public
  method are possible; do not confuse them with permission to write Outputs.
- `viewer`: no runtime operations. `context` exposes presentation context only.

Every resource operation additionally needs a matching `resourceGrants` slot
and operation. Bind Output slots to active workspace resources with
`providerId: "tedix"`, `resourceType: "output"` and the verified Output ID as
`providerResourceId`. Neither a grant nor settings bypass source access or
provider approvals. Validate public method arguments on the server. App storage
is shared within an app, isolated from other apps; preview storage is separate.

## Draft, check, hand off

For a new app, create the gadget record and initial runtime revision with
`expectedRevision: 0` only when installation is requested. For an existing app,
read its code and revision first. Discover the equivalents of
`osAppRuntime.saveDraft` (content `{manifest, files}`, `expectedRevisionId`),
`draft` (open by `proposalId`) and `mergeDraft` (compare with current main).
Code edits save a proposal, not a committed revision. Resolve conflicts against
the latest code, retaining concurrent edits. Leave the reviewed draft for the
person to apply in OS; do not call apply/merge/publish to finish this workflow.
A preview permits resource reads only and has separate storage; saved preview
ratings are not production results. Never publish or create a share link.

Limits: 24 files, 512,000 UTF-16 code units total; required two JS files,
optional lowercase single-segment `.js`, `.json`, `.txt` names and the exact
`README.md`. README counts toward limits and digest but is not loaded as code.
Browser code is inline `client.js`; extra server modules do not become browser
imports. Calls accept at most 50 JSON arguments and 65,536 encoded bytes;
method names are 1–80 alphanumeric characters starting with a letter, excluding
constructor and lifecycle methods. Sessions pin revision, digest and access;
reopen after a revision/access change rather than retrying stale writes.

Handle bridge errors visibly: `not_permitted` (role/grant), `slot_unbound`
(missing active binding), `bad_arguments`, `unknown_method`, `host_unavailable`
and `host_error` (server/transport failure). API calls may report `BAD_REQUEST`,
`FORBIDDEN`, `NOT_FOUND` or `CONFLICT`; re-read on conflict. Do not turn a failed
read into an empty success or claim a failed write saved. Enable a bounded
manual retry and preserve user input.

Before handing off:

- Own light-theme colours on `:root` (`color-scheme: light`, background, surface,
  foreground, muted, border, accent and on-accent); the host gives no tokens.
- Write plain copy in the language the organization or workspace uses (never
  assume one) and keep it in `config.settings`; use semantic buttons, visible
  focus and labelled controls.
- Confirm resets inside the app; sandboxed native `confirm()` dialogs are blocked.
- Make touch targets at least 44 × 44 CSS pixels. Check phone width (375px),
  desktop, long text, loading, empty and denied/error states.
- Exercise tabs, rating, reload and reset; test keyboard operation. Keep the
  source sheet unchanged unless an independently authorized write was requested.
- Read back draft files, manifest and revision. Record checks and the draft/app
  OS link on the matching Work. Name simulated versus live checks. Never publish.

For the full public contract and built-in app alternatives, read
[Build a workspace app](https://docs.tedix.dev/build-a-workspace-app).
