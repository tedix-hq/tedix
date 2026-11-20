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

The browser has no network, OS DOM, credentials or imports: no npm packages,
CDN scripts or component library such as the OS's own Kumo. Build the page
with plain DOM and one `<style>` element. It does receive the Tedix OS look
(see [Look and feel](#look-and-feel)).
Its bridge resolves values directly and rejects errors with `code` and `detail`:

```js
const { role, settings, grants } = await tedix.call("context");
const content = await tedix.call("outputs.read", { slot: settings.slot });
const result = await tedix.call("app.call", {
	method: "rate",
	args: [id, "useful"],
});
```

Browser methods for these apps include `context`, `outputs.read`, `app.call`
and `app.openLink`. `context` also includes `workspaceId`
and `gadget: {id, name, revision}`. `outputs.read` returns an Output content body,
not a response envelope. `app.call` invokes an own public method of `App.prototype`.
`app.openLink` takes `{url}` and works for every role, including share-link
guests. Pass an absolute HTTPS URL of at most 4,096 characters without a
username or password. HTTP works for loopback URLs when OS runs on loopback.
A same-origin URL whose path starts with `/s/` opens in the current tab.
Other allowed links open in a new tab without an opener or referrer.
Call the method directly in the click handler, before awaiting other work.

```js
const link = document.createElement("a");
link.href = "https://example.com/guide";
link.textContent = "Read the guide";
const status = document.createElement("p");
status.setAttribute("role", "status");
link.addEventListener("click", async (event) => {
	event.preventDefault();
	try {
		await tedix.call("app.openLink", { url: link.href });
	} catch {
		status.textContent = "Could not open the guide.";
	}
});
document.getElementById("app").append(link, status);
```

To hand the workspace agent a task for the person using the app, add
`"agent.ask"` to the manifest's `capabilities` and call `agent.ask` from a
click. The message is sent as that person's own, shows in workspace chat
with "Asked from" and the app's name, and follows their usual access and
approvals. It works only for signed-in people with at least `use` access,
never for share-link visitors or scheduled app code. `agent.status` reports
what the chat in the same page has seen of that turn.

```js
button.addEventListener("click", async () => {
	const { turnId } = await tedix.call("agent.ask", {
		text: "Summarise the open rows of the Opportunities sheet",
		conversation: "new", // or "current"
	});
	// Later: { status: "running" | "waiting" | "done" | "error", text }
	const { status, text } = await tedix.call("agent.status", { turnId });
});
```

Export `class App` from `server.js`; its constructor receives `(ctx, env)`.
Use synchronous `ctx.storage.kv.get/put/delete/list` for durable app state.
An App instance is created per call; instance fields are not persistence.
`env.CONFIG` is the full manifest config (settings under `.settings`).
`env.TEDIX` is a scoped capability valid only during that invocation:

```js
const { revision } = await this.env.TEDIX.outputsRead(slot, {});
const content = revision.content;
```

To show a project's live Work board, bind a slot to a Tedix `project`
resource and grant it `work.read`; then
`await this.env.TEDIX.workRead(slot, {limit, offset})` returns
`{project, rows, pagination}` for that project only (limit at most 50). Read
on open and on Reload instead of copying Work into a sheet.

Build callers may also use `outputsWrite(slot, {content, expectedRevision})`,
`connectionsCall` and `skillsRun` when the
role, resource type, manifest grant and current authorization all allow it.
Discover current schemas before adding any such effect. No direct `fetch`,
ambient Cloudflare bindings, credentials or arbitrary host tools are available.

## Look and feel

The frame sets `--tedix-*` CSS variables on `:root` and updates them live
when the person switches light/dark, the organization changes its colours, or
reduced motion turns on. It also sets `color-scheme`. Style only with these,
so the app matches Tedix OS in both modes:

| Variable                                               | Use it for                           |
| ------------------------------------------------------ | ------------------------------------ |
| `--tedix-bg`, `--tedix-fg`                             | Page background and text             |
| `--tedix-surface`                                      | Cards and panels                     |
| `--tedix-muted`, `--tedix-muted-fg`                    | Quiet backgrounds and secondary text |
| `--tedix-border`                                       | Lines and outlines                   |
| `--tedix-primary`, `--tedix-on-primary`                | The main action and the text on it   |
| `--tedix-danger`, `--tedix-warning`, `--tedix-success` | Errors, warnings and good states     |
| `--tedix-font`, `--tedix-font-mono`                    | Font stacks                          |
| `--tedix-radius`                                       | Corner radius                        |

Give each a system-colour fallback, such as `var(--tedix-surface, Canvas)` or
`var(--tedix-primary, AccentColor)`. Do not hard-code colours, a palette or
`color-scheme`; tint with `color-mix()` over these variables when you need a
shade. Animate with CSS transitions or animations only: the frame stops them
when reduced motion is on, which it cannot do for JavaScript timers.

### UI kit

Start every `client.js` with [the UI kit](assets/ui-kit.js), pasted unchanged
(browser code cannot import it). It defines `ui` with accessible, themed
building blocks, so the app looks like Tedix OS and needs no other component
library:

| Helper                                                                          | Gives you                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ui.el(tag, {class, text, attrs, on}, ...children)`                             | Any element; text is never parsed as HTML                                     |
| `ui.button(label, onClick, {variant, disabled, class})`                         | A 44 px button; `variant` is `primary` or `quiet`; `class` adds your own      |
| `ui.tabs({id, label, items, value, onChange})`                                  | A tab row with arrow, Home and End keys; the panel takes id `${id}-panel`     |
| `ui.table({caption, columns, rows, pageSize, page, onPage, labels, empty})`     | A scrollable table with an optional pager                                     |
| `ui.select({label, options, value, onChange})`                                  | A labelled select                                                             |
| `ui.confirm({label, question, confirmLabel, cancelLabel, onConfirm, onCancel})` | An in-app confirmation (native `confirm()` is blocked)                        |
| `ui.status(text)`, `ui.alert(text)`                                             | Announced progress and errors                                                 |
| `ui.chips({label, items, value, onChange})`                                     | On/off filter chips; the chosen one is pressed                                |
| `ui.tag(text, tone)`                                                            | A small label; `tone` is `success`, `warning`, `danger`, `accent` or `strong` |
| `ui.card({title}, ...children)`                                                 | A bordered panel with an optional heading                                     |
| `ui.tile({value, label, onClick})`                                              | A key figure; with `onClick` the whole tile is one button                     |
| `ui.bars({label, entries, onPick})`                                             | Horizontal bars from `[[name, count], ...]`; `onPick` makes rows buttons      |

The kit adds no words of its own: pass every label from `config.settings`.
Its classes start with `tx-` and its colours with `--tx-`; reuse them in the
app's own small `<style>` instead of new colours. The review starter shows
the kit in use. Add a helper to the kit here, not by editing a copy in one app.

## Offer file downloads

Add formats to `config.exports` to show an **Export** menu on the app. Give
each entry a unique menu `name`, a `mimeType` of `text/csv` or
`text/markdown`, and a `handler` name.

In `client.js`, register the handler with
`tedix.registerExport("handlerName", () => fileText)`. It returns text or a
promise for text, up to 8 MB of UTF-8 text. It runs with the access of the
person who chooses the format. Leave the list out or empty to hide the menu.

## Roles and grants

- `owner` and `build`: `app.call`, Output reads/writes, connection calls,
  skill runs and Work board reads (`work.read`).
- `use`: `app.call`, Output reads and Work board reads. App-local KV writes through a public
  method are possible; do not confuse them with permission to write Outputs.
- `viewer`: `context` for presentation context and `app.openLink` for clicks.

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

Limits: 1,800,000 bytes for all files together; required two JS files,
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

- Style only with the `--tedix-*` variables from [Look and feel](#look-and-feel),
  each with a fallback; no hard-coded colours and no `color-scheme`. Check the
  app in both light and dark mode.
- Write plain copy in the language the organization or workspace uses (never
  assume one) and keep it in `config.settings`; use semantic buttons, visible
  focus and labelled controls.
- Do not build a language switch: Tedix offers Translate in its own bar when the
  viewer's language differs. Name the app's language in `settings.locale`, put
  fixed wording for short labels in `settings.glossary.<language>` (original
  text to wording), and mark names, scores and quoted text `translate="no"`.
- Confirm resets inside the app; sandboxed native `confirm()` dialogs are blocked.
- Make touch targets at least 44 × 44 CSS pixels. Check phone width (375px),
  desktop, long text, loading, empty and denied/error states.
- Exercise tabs, rating, reload and reset; test keyboard operation. Keep the
  source sheet unchanged unless an independently authorized write was requested.
- Read back draft files, manifest and revision. Record checks and the draft/app
  OS link on the matching Work. Name simulated versus live checks. Never publish.

For the full public contract and built-in app alternatives, read
[Build a workspace app](https://docs.tedix.dev/build-a-workspace-app).
