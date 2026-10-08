---
summary: "Cross-surface design-system decisions, UI runtime ownership, tokens, and component rules"
read_when:
  - Updating Tedix OS, widget, landing, or CMS UI behavior
  - Choosing the correct UI owner and component system
  - Adding a token, component adapter, or page layout
title: "Design system"
---

# Tedix Design System

This page owns the cross-surface design decisions for Tedix. When code and this
page diverge, fix one of them in the same change; do not keep parallel local
rules.

## UI Runtimes And Owners

Tedix has several UI runtimes, not one universal frontend. Each owns its
pattern; they share tokens and contracts, not components.

| Runtime                   | Owner                      | Stack and contract                                                                                                                                              |
| ------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tedix OS                  | `apps/os`                  | Client-rendered TanStack Router + Query app; Tedix tokens over app-local Cloudflare Kumo adapters in `apps/os/src/components/kumo/`. The only product frontend. |
| MCP Apps / widget runtime | `apps/mcp-ui`              | Astro SSR with React islands, MCP Apps host context, json-render, `@tedix/widget-ui`, stable widget resource contracts.                                         |
| Embedded host widget      | `apps/widget`              | Framework-neutral Shadow DOM surface; signed sessions from the host's same-origin bootstrap; sandboxed tool projections loaded from `apps/mcp-ui`.              |
| CMS public sites          | `apps/cms/templates/tedix` | Emdash template: locked infrastructure and editorial globals, per-org retheming through `src/styles/theme.css` and platform branding injection.                 |
| Marketing site            | `apps/landing`             | Astro SSR Worker; app-local pages, content, styles, and React islands own marketing composition. CMS tenant sites have a separate runtime and editing boundary. |
| Shared widget components  | `packages/widget-ui`       | Embeddable widget primitives, composites, and layouts. Not an OS component package.                                                                             |
| Shared tokens             | `packages/design-tokens`   | Typed token source for OS (via the Kumo bridge) and widgets.                                                                                                    |

## Tedix OS Product Character

Tedix OS is a quiet command center for digital workers: calm enough for daily
business work, precise enough to trust with permissions, budgets, records, and
live systems. It is not a generic analytics dashboard, a developer console with
chat added, or a wall of interchangeable cards.

Every primary OS view answers, in order:

1. What needs attention?
2. What is working now?
3. What changed or completed?
4. Why did it happen?
5. Where is the supporting record?
6. What can the operator safely do next?

Business outcomes lead; infrastructure detail follows on demand.

### Interaction qualities

Use scannable lists, clear operational hierarchy, selective system visualization,
explicit agent states, readable documents, and progressive trace inspection.
Avoid navigation overload, decorative spectacle, ambient glow, chat as the only
control surface, raw trace payloads as the default view, and large dead zones.
Tedix owns its tokens, adapters, identity, and terminology.

### Information hierarchy

Progressive disclosure runs `outcome -> current state -> rationale -> record ->
machine detail`.

- Outcome copy uses the operator's language, not a transport, model, queue, or
  table name.
- Current state is short and categorical: `queued`, `working`, `blocked`,
  `awaiting approval`, `ready for review`, `completed`, `failed`.
- Rationale is bounded; long reasoning, tool calls, subagent work, and raw
  events stay collapsed until requested.
- Permission, budget, and provenance sit beside the action or state they
  qualify, not in a separate audit area.
- Machine detail lives in an inspector, disclosure, tooltip, or diagnostic
  view. IDs use mono type and are never the primary label when a human name
  exists.
- On phones, a long supporting legend may collapse behind one 44px Kumo
  disclosure as long as the primary state stays visible and every item remains
  one tap away.
- Disclosure labels keep the page's left reading edge when they wrap.

Status color is used sparingly: shape, icon, label, and position carry meaning
without color. The organization accent marks selection, progress, links, and
the primary action — it is not ambient decoration. Primary Kumo actions pair
the accent with the theme compiler's `--primary-foreground`; call sites must not
force a white label.

### Page archetypes

Choose one archetype before composing a route:

| Archetype                 | Use for                                                | Required behavior                                                                                                 |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Operational table         | Work queues, runs, outputs, connections, records       | One bounded toolbar; rows scan without card chrome; selecting a row opens detail without losing list context      |
| Master-detail inspector   | Work Items, runs, approvals, apps, tedis               | Summary stays visible while the inspector exposes rationale, records, and actions progressively                   |
| System canvas             | Workspace, topology, orchestration, live collaboration | Canvas earns edge-to-edge space; overlays and inspectors are explicit layers; navigation chrome stays subordinate |
| Conversation and artifact | Chat, documents, sheets, slides, generated views       | Conversation and artifact are peer panes, not nested cards; approval gates keep a visible permission boundary     |
| Operational overview      | Work queue and domain landing pages                    | Ready work and current operations lead; recent outcomes follow; metrics appear only when they change a decision   |

Settings pages are a readable single lane with named sections, not dashboards.
A sticky in-page section rail marks exactly one current section with a visible
selected treatment and `aria-current`; its hash links keep link semantics.
Galleries are reserved for genuinely visual resources such as Blueprints and
Outputs.

Page width follows the archetype, using the `Page` lanes from
`apps/os/src/components/kumo/page.tsx`:

- `md` (`max-w-4xl`): settings, forms, focused detail.
- `lg` (`max-w-5xl`): default console lane for overviews, lists, compact
  galleries, and master-detail inspectors.
- `xl` / `full`: dense operational tables and multi-column inspectors.
- `bleed`: system canvases and peer work panes.

Do not keep an overview in the readable lane just because today's dataset is
short. `Page` owns the gutter rhythm (16px phone, 24px from `sm`, 40px desktop);
routes must not override Page padding or add a second header inset. Detail
shells compose `PageBack`, `PageHeading`, and `PageMeta`; the back control
restores the owning list context.

### Visual composition rules

- One visually dominant primary action per section or modal. Secondary actions
  stay neutral; destructive actions stay isolated and explicit. Destructive
  settings keep the neutral card boundary and reserve danger color for the
  title, action, confirmation, and active error.
- At most three persistent surface levels: canvas, bounded surface, overlay. A
  surface never contains another full card merely for padding. A card is
  justified by selection, independent scrolling, elevation, or a real object
  boundary — not by having a heading.
- Page title and route actions live in one stable header; never repeat the
  title inside the first card. `PageTitle` and `PageDescription` own their type
  roles; `PageHeader` owns layout only.
- Filters sit next to the data they affect. `PageToolbar` owns the bounded
  control surface (8px radius, semantic line, canvas fill, no elevation) and
  the responsive stacking; each control declares its own desktop width. Use
  `appearance="inline"` only when a parent surface already owns the boundary.
  Dense filter sets may opt into a responsive grid; on phones they may collapse
  behind a disclosure that names the active filters and count.
- Operational search uses the `SearchInput` adapter; result counts and hints go
  in its trailing addon, not the placeholder.
- Read-only status summaries in one section render as one divided
  `Collection` / `SectionCollection` (both in `page.tsx`), not a row of peer
  cards. Entitlement lists follow the same rule, with a labeled included/not
  included state rather than color alone.
- Metrics use `MetricGrid` / `MetricItem`: one semantic description list, one
  hairline system, tabular values, explicit semantic tone when a count needs
  escalation. Do not rebuild `divide-x` grids in feature code. Three-item groups
  use two phone columns with the last item spanning, then three columns from
  `sm`.
- In stacked mobile records, the title and its secondary identifier share one
  left edge.
- Empty states say what is absent, why it matters, and the single best next
  action, via the `Empty` adapter (`quiet` for an absent collection, `inline`
  inside an existing boundary).
- Charts need a named decision, a visible time range, and designed empty and
  loading states.
- Motion communicates progress, reordering, expansion, arrival, or a changed
  layer. Idle surfaces do not glow, float, pulse, or animate gradients.

### UX acceptance checklist

A visible OS change is done when the relevant answers are yes:

- Is the next safe action apparent without reading implementation detail?
- Does the page use one archetype and the Kumo adapter grammar?
- Is there only one boundary, selected treatment, or shadow per hierarchy step?
- Do spacing and control sizes use the token tiers?
- Are loading, empty, error, blocked, approval, and completed states designed?
- At 390px: no page-level horizontal overflow, touch targets at least 44px?
- At tablet widths: do lists keep decision-critical fields visible?
- At desktop widths: is density sufficient to compare adjacent state?
- Can keyboard and assistive-technology users identify state, selection, and
  actions without color?
- Are rationale, permission, budget, and provenance available where they affect
  a decision?
- Has the route been checked in a real browser?

## Tokens

Use semantic tokens first; never hardcode a color, radius, or font stack a
surface already exposes. `@tedix/design-tokens` owns the shared vocabulary,
with typed values and CSS kept in parity by tests:

- `@tedix/design-tokens/kumo.css` — Kumo typography and semantic role bridge.
  `apps/os/src/kumo-tedix.css` loads Kumo, then this bridge over the Tedix
  palette. Kumo's default palette is not a Tedix theme.
- `@tedix/design-tokens/widget` and `widget.css` — embeddable widget baselines
  (radius, weight, control height, gap, padding, touch target, icon size)
  consumed by `@tedix/widget-ui/globals.css`.
- `@tedix/widget-ui/design-tokens` — widget package bridge for consumers that
  should not import the token package directly.

New shared runtime decisions map back to `packages/design-tokens`.

### Spacing

- Layout scale is 4px-based: `4`, `8`, `12`, `16`, `24`, `32`. Kumo control
  internals may use the half steps (`2`, `6`, `10`, `14`, `18`, `20`) already in
  `@tedix/design-tokens`; those are component geometry, not layout gaps.
- Widgets layer density over the `widget.css` baseline; do not redefine it.
- Avoid arbitrary spacing unless a protocol, viewport, or aspect-ratio
  constraint requires it.

### Typography

- Kumo-backed apps share the FT Kunst/Apercu fallback stacks and these roles
  from `kumo.css`: `text-tedix-caption` (11/16), `text-tedix-label` (12/16),
  `text-tedix-control` (13/18), `text-tedix-body` (14/20),
  `text-tedix-section` (16/22), `text-tedix-dialog` (18/24).
- OS adapters pin controls to roles: extra-small controls use `caption`;
  compact 28–32px buttons, tabs, segmented controls, selects, and menu items
  use `control`; standard 36–40px buttons and inputs use `body`; badges use
  `label`; section titles use `section`; dialog, sheet, and prominent empty
  titles use `dialog`.
- Weights: normal body, `font-medium` labels/actions, `font-semibold` titles.
  Hover never changes weight.
- Widget UI uses the Apps SDK-aligned stack in `@tedix/widget-ui/globals.css`;
  `apps/mcp-ui` overrides with Raleway (`--font-sans`) and Comfortaa
  (`--font-display`).
- CMS templates expose `--font-sans` and `--font-display`.
- Letter spacing is `0`; uppercase tracking is reserved for labels and status
  metadata.

### Radii

OS uses two radius tiers so a card reads as a layer above its controls:

- **Top-level surfaces — 12px** (`--radius-xl`, `calc(var(--radius) + 4px)`):
  cards and panels that sit directly on the canvas. Use the `Card` and `Surface`
  adapters (`card.tsx`, `surface.tsx`), which override Kumo `LayerCard`'s
  default.
- **Controls and nested wells — 8px** (`--radius`): buttons, inputs, selects,
  nav rows, tabs, badges, and any bounded region inside a card (payload box,
  diff pane, code well). `Surface` defaults to `tier="well"`; `tier="panel"` is
  the deliberate promotion.
- `--radius` is the control token. Move the card tier at the adapter or via
  `--radius-xl`, never by bumping `--radius` (that shifts the whole control
  ladder).
- Overlays (dialogs, sheets, popovers, menus) keep Kumo's own geometry.
- `@tedix/widget-ui` sets `--radius: 0.5rem` with a 2–24px scale. Landing and
  CMS templates keep their own radii locally; they never leak into OS.

### Control density

- Heights: `24px` extra-small/icon chrome; `28px` compact text, select, tab,
  segmented control; `32px` compact icon-only and default tab group; `36px`
  standard; `40px` large.
- Touch targets are keyed to pointer capability, not viewport width. OS defines
  a `coarse:` Tailwind variant (`@media (pointer: coarse)`) in
  `apps/os/src/styles.css`; use it for 44px hit-target floors and keep `sm:` /
  `md:` for real layout changes.
- Under coarse pointers, `input`, `select`, and `textarea` are floored to 16px
  text so iOS Safari does not zoom on focus. This is a deliberate exception to
  the 13/14px control tiers; checkbox, radio, range, and color inputs are
  excluded. It lives in `apps/os/src/styles.css` with `!important` because the
  `.type-tedix-*` roles are themselves important.
- Input `size` props map to the role tiers; feature pages choose `size` and do
  not restyle height, radius, or font size.
- Selected tabs and segmented items use `bg-kumo-tint` inside one group
  boundary — no second ring, border, or shadow.
- Routed secondary navigation uses the line-tabs adapter: a full-width hairline
  rail with contiguous triggers and a brand-color active indicator. Overflow
  shows Kumo's scroll fade and keeps native scrolling and keyboard focus.
- Cross-route capability navigation (Apps, Skills, connections) uses linked
  controls in one non-wrapping scrollable rail with directional controls at
  hidden edges; never wrap into a second row or overflow the page.
- Non-interactive entity icons use `IconFrame` (`md` 36px default, `sm` 32px in
  compact rows; `fill` or `outline` appearance). Status meaning stays in the
  adjacent badge or label.
- Settings rows keep icon and copy in one mobile row with the control on the
  next full-width row, returning to a trailing column from `sm`.
- Inventory rows carry at most two categorical badges beside the name; other
  facts render as labeled metadata. Separate facts (provider availability,
  credential presence, installation, protocol health) never collapse into a
  generic `Healthy`.

**Responsive tables.** Dense tables keep their table shape where their columns
fit. When decision-critical fields would be clipped or pushed offscreen, provide
a `Collection` projection below the breakpoint the table actually needs, with
the same identity, status, key value, recency, and actions. Horizontal scrolling
is for genuinely matrix-shaped data, not entity lists. Responsive reduction
changes presentation only — never link targets, mutations, or authorization.

**Viewport.** `100dvh` does not shrink for a software keyboard. OS publishes
`--viewport-tedix-height`, `--viewport-tedix-top`, and `--viewport-tedix-bottom`
from a `visualViewport` listener (`apps/os/src/lib/viewport-metrics.ts`);
full-height shells and overlays size from those and keep `100dvh` only as the
pre-JS default. `apps/os/index.html` sets `viewport-fit=cover` (required for
`env(safe-area-inset-*)`) and `interactive-widget=resizes-content`. Dialogs
become bottom sheets below 768px wide or 520px tall inside the `DialogContent`
adapter.

### Elevation, borders, and motion

Most operational content is flat, structured by spacing and a semantic border.
Elevation marks a changed layer, never importance.

- `shadow-tedix-raised` for a raised canvas or active composition;
  `shadow-tedix-floating` for anchored menus, popovers, and detached in-canvas
  controls; `shadow-tedix-overlay` for sheets and dialogs; directional drawer
  tokens for mobile navigation. No custom glow, backdrop blur, or hover lift on
  ordinary rows or cards.
- `border-kumo-hairline` separates rows and cells; `border-kumo-line` encloses a
  real surface; focus and selection use the Kumo ring. Do not stack border,
  ring, and shadow on one selected item.
- Bounded surfaces paint `bg-kumo-base` at both radius tiers. `fill`, `tint`,
  `control`, and `recessed` are distinct roles, not alternate spellings of "a
  box". Compose `Card` or `Surface` and let the adapter own background, border,
  radius, and elevation; call sites own layout only.
- The `Card` root owns vertical padding and the header/content/footer gap. Do
  not add Shadcn-style `p-*`/`pt-*`/`pb-*` to card parts; small metric tiles use
  `size="sm"`. `CardTitle` owns the 14/20 medium role.
- Tables use Kumo's compact header and flat rows separated by hairlines — no
  zebra striping, row shadows, or card per record. Tint is for hover and
  selection.
- Motion uses `tedix-fast` (100ms), `tedix-standard` (150ms), or
  `tedix-structural` (200ms) with standard easing, on explicit properties (not
  `transition-all`). Write the token, not a literal. Brand marks and
  illustrations do not animate.
- OS applies a global `prefers-reduced-motion` fallback plus an operator motion
  preference; adapters carry `motion-reduce` where their lifecycle depends on a
  transition. Landing, widgets, and CMS adopt the accessibility fallback but do
  not import Kumo controls or console elevation.

The adapters under `apps/os/src/components/kumo` are the product control
boundary. Route and feature code import those adapters, never Kumo's aggregate
barrel; `bun run lint:kumo` enforces this.

### Stacking

The z-index ladder lives in `packages/design-tokens/src/kumo.css` as
`--tedix-layer-*` and is the only vocabulary OS surfaces use. Write
`z-(--tedix-layer-dropdown)`, never `z-50` or `z-[1100]`.

| Layer                     | Value                  | Use                                                                       | Applied by                                                                  |
| ------------------------- | ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| —                         | `10`–`30`              | In-flow sticky chrome inside its own scroller; stays a local literal      | local `z-[1]`–`z-10`                                                        |
| Kumo sidebar              | `40`                   | Kumo-owned; every Tedix layer clears it                                   | Kumo                                                                        |
| `--tedix-layer-overlay`   | `100`                  | Modal backdrop plus panel                                                 | `kumo/sheet.tsx`, `kumo/dialog.tsx`                                         |
| `--tedix-layer-dropdown`  | `200`                  | Anchored positioners: select, popover, menu                               | `kumo/select.tsx`, `kumo/popover.tsx`, `kumo/dropdown-menu.tsx`             |
| `--tedix-layer-tooltip`   | `300`                  | Tooltip positioner                                                        | `kumo/tooltip.tsx`                                                          |
| `--tedix-layer-toast`     | `1000`                 | Mirrors Kumo's own toast anchor so higher rungs can be ordered against it | Read only; Kumo's toast sets its own z-index                                |
| `--tedix-layer-immersive` | `1100` (`toast + 100`) | Fullscreen stage or lightbox — the only surface that may cover a toast    | Reserved; current fullscreen uses `requestFullscreen()` (browser top layer) |

Rungs are spaced in hundreds so new layers slot in without renumbering. Two
rules make the ladder hold:

- **The layer goes on the positioner, not the popup.** Base UI positions
  anchored popups with a transform on the positioner, which makes it a stacking
  context; a z-index on the popup only orders its children. Sheet has no
  positioner, so it carries the layer on backdrop and popup.
- **Keep `isolate` on the Select positioner.** With `alignItemWithTrigger` (the
  adapter default) Base UI drops the transform for bare `position: fixed`, so
  `isolation: isolate` is what contains the popup's sticky scroll buttons.

Popover and DropdownMenu adapters compose Kumo's exported Base UI primitives so
they can put the rung on the positioner. Dialog mounts its backdrop/popup pair
into an isolated overlay-layer portal host (`kumo/layer-portal.ts`) so nested
anchored controls sit above it without a literal z-index at call sites.

### Colors

- Prefer semantic names: `background`, `foreground`, `card`, `muted`,
  `primary`, `secondary`, `accent`, `destructive`, `border`, `ring`, `success`,
  `warning`, `info`.
- OS maps the Tedix OKLCH palette into Kumo semantic variables and adds only
  narrow local tokens such as `--highlight`.
- The bridge in `packages/design-tokens/src/kumo.css` is name-matched with no
  compile-time check: a token Kumo renames stops being projected and the
  component silently falls back to Kumo's default. `bun run lint:kumo` compares
  the installed library's token names with the projection. Tooltip/popover
  arrows use `--color-kumo-arrow-edge` (light) and `--color-kumo-arrow-stroke`
  (dark); mirror that swap rather than tinting both.
- Tokens Kumo declares on a component root rather than `:root` (for example
  `--kumo-code-highlight-bg` on `.kumo-shiki`) must be matched on Kumo's own
  selector; the bridge imports after `@cloudflare/kumo/styles`, so source order
  wins.
- `lint:kumo` rejects raw Tailwind palette utilities (`bg-emerald-500`,
  `text-amber-700`) in `apps/os/src`, because they ignore the tenant palette.
  Use Kumo semantic tokens or a `--tedix-hue-*` token for categorical hues.
  Stories, tests, build output, and generated declarations are excluded.
- Widget UI owns its Apps SDK-aligned grayscale, semantic, alpha, and component
  tokens; apps may inject branding over them. CMS templates use `--color-*`
  variables with per-org overrides.
- No new dominant global palettes; brand moments stay inside the owning
  surface.

**Neutral ladder.** OS neutrals are a surface ladder, not copied swatches. In
dark mode the canvas is `#030303` (OKLCH `0.10`) and each real surface climbs
away from it: elevated `0.12`, recessed `0.15`, base/card `0.17`, control
`0.205`, tint/hairline/overlay `0.269`, line `0.32`, interactive `0.371`. Light
mode inverts the direction: shell tones recede below the `#fbfbfb` canvas while
cards and inputs lift to white and take elevation from shadow. The navigation
rail stays on the canvas; selected navigation uses the solid control step. A
collapsed ladder (canvas-on-canvas cards and inputs) is the failure mode.
Links and focus use `#4693ff` in dark mode and `#1267c4` in light mode for AA
contrast. Status and categorical hues are Tedix-owned.

### Tenant OS appearance

Organization administrators may publish a constrained appearance profile:
separate light and dark accent/background/foreground inputs, a surface-contrast
value, and allowlisted UI and code fonts. The profile is the visual default;
each operator still owns mode, density, motion, and high-contrast preferences,
and accessibility preferences only narrow the published appearance.

- The wire contract is `OrganizationOsThemeSchema`
  (`packages/api-contract/src/schemas/organization.ts`). Tenant input never
  contains arbitrary CSS, Tailwind classes, Kumo internals, remote font URLs,
  or component overrides. Foreground/background and accent/background pairs
  are contrast-validated at the API boundary; secondary surfaces are derived
  with `color-mix()`, not stored.
- `apps/os/src/lib/organization-theme.ts` compiles the profile into the
  `background`/`foreground`/`primary` layer, which the Kumo bridge projects into
  `--color-kumo-*`. `contrast` scales the ladder and never reorders it.
- **High contrast is a compiler input, not a stylesheet override.** The profile
  writes colors as inline styles on `<html>`, which outrank any
  `:root[data-contrast="high"]` rule. `organizationThemeVariables` therefore
  takes the flag and floors the hairline, control edge, and secondary text
  toward the palette's own foreground — floors, never replacements.
  `applyOsPreferences` writes `data-contrast` before applying the theme. The
  untenanted high-contrast block in `apps/os/src/styles.css` uses the same
  strengths; keep the two paths in agreement.
- `applyOrganizationTheme` writes `color-scheme` from the same background
  luminance test that selects the surface ladder, because every `light-dark()`
  in the bridge resolves off `color-scheme`.
- The published profile lives in organization metadata and is delivered in the
  OS operational context. A per-origin browser cache exists only to avoid a
  first-paint flash; the server value replaces it after hydration. This
  contract is OS-only and does not reuse widget branding or CMS `theme.css`.

## Component Ownership

### `packages/widget-ui`

The widget/App SDK package for embeddable MCP resources, in three layers:
primitives, composites, and vertical layouts.

- Import primitives from `@tedix/widget-ui/*` and layouts from
  `@tedix/widget-ui/layouts`.
- Shared widget CSS variables live in `@tedix/design-tokens/widget.css`.
- Controls consume `--widget-control-*` and `--widget-icon-size-*` instead of
  hardcoded Tailwind sizes.
- Host hooks stay in `apps/mcp-ui`; layouts receive props and callbacks.
- Use `destructive`, not `danger` (shadcn naming).
- Use lucide icons unless a component already owns another icon contract.

### Raw HTML

Raw HTML is fine for document structure, SSR shells, CMS editorial output, and
Astro templates. It is not a substitute for an existing component primitive in
React product UI.

## Surface Rules

### Tedix OS

`apps/os` is deployed as one multi-tenant Worker serving `{slug}.os.<domain>`
plus a central launcher. Work and the Workspace workbench are modes of one
frontend sharing identity, tokens, and chrome. `apps/os` owns composition;
`@tedix/design-tokens` owns portable density, spacing, radius, and type.
Canonical data, policy, execution, artifacts, and audit stay with their API
owners. See [tedix-os.md](tedix-os.md).

Route and data composition: file routes own URL and layout hierarchy; route
loaders validate identity-bearing params and prefetch first-paint state;
generated oRPC query options (`apps/os/src/lib/os-query-options.ts`) own query
keys; live subscriptions update or invalidate only those keys and then
reconcile with the API. Browser-only editor or collaboration resources need an
explicit owner and cleanup path.

Work is the tenant root route (the index redirects to `/work`); a Workspace is
`/workspace/{uuid}`. Neither is an iframe. Opaque sandbox frames remain the
boundary for untrusted Gadget previews and MCP Apps widgets.

**Shell.** The Kumo rail is 260px expanded and 56px collapsed. Its header
shows the current organization and opens the workspace/app switcher; its
footer keeps settings, billing context, profile, and the collapse control.
One pinned sidebar search opens the command palette on an expanded desktop
rail. The route-context bar exposes search when the rail is collapsed or
replaced by the mobile sheet, and `Cmd/Ctrl+K` works throughout. The bar uses
the same responsive 16/24/40px gutters as `Page`. Work, Chat, Workspaces,
Outputs, and Install Tedix are direct destinations. Capabilities groups Team,
Skills, MCP Gateway, Sites, and Brain; Manage groups Blueprints, Widget, Audit,
and Usage & budgets. Page width follows the archetype above. Large result sets
paginate or scroll inside a bounded panel.

**Workspace workbench.** Opening a Workspace replaces the rail with a 56px
Workspace header and full-width workbench. Chat keeps a persisted,
user-adjustable 420px column beside the workpiece stage. Resources and Work are
full library panes; the resource workbench stays mounted while Work is
selected, preserving editor and chat state. Work offers List, Board, and
Timeline over the same Work data; running/waiting labels require a live,
unexpired Attempt. Below 960px Canvas shows one Resources/Work/Chat/Workpiece
pane at a time. Canvas has one `main` landmark; panes are complementary
regions. Output modes are named **Document**, **Sheet**, **Slides**, and
**Video**; the combined chat-plus-artifact surface is **Workbench**; proposal
history is **Review**; run history is **Activity**. Review keeps proposals in
their own section with a visible pre-merge boundary.

**Editor chrome.** One 48px tab/mode bar and one 40px scrollable title/action
row (title, saved/draft status, Export menu, icon-sized Share, Resources, and
Focus). Share, Edit, and Archive use the 32px icon-action tier. Chat transcripts
belong to their pane; only the composer and approval gates keep borders. Tool
calls and delegation progress render as compact inline activity rows.
Direct `/outputs/{outputId}` uses the 56rem lane for revision detail; **Edit**
switches to the full-height workshop layout shared with Canvas through
`apps/os/src/components/output-workshop.tsx`.

**Output surfaces.** Documents render as a fixed-light page on a recessed
`--tedix-desk`: no radius, no border, a page shadow, a paper up to 72rem wide
with a 48rem prose measure. The paper stays light because the editor surface is
the export surface — `apps/api/src/lib/os-output-html.ts` renders PDF/PNG on
white with the author's stored colors, so a dark editor would let users pick
ink that vanishes on export. A theme-following page would first require storing
text colors as semantic names. Sheets use a light office grid with a single 40px
formula row and 28px data rows. Slides use a rounded 16:9 canvas on a fixed-light
neutral stage (the radius separates the white slide from its pale stage, so no
border is needed); do not point the slide stage at `--tedix-desk`. Read views
reuse their editor's chrome (`.document-page`, `.document-prose`, `.sheet-page`,
and the shared slide `ReadOnlyElement`) so a saved revision and its draft look
like the same object. Editor toolbars are one scrollable row at least 48px tall,
grouped by spaced hairlines, with every control either a labeled Select or a
square icon target.

**Native documents.** Common formatting stays visible; secondary formatting
lives in an accessible More panel. Links expose Open, Edit, and Remove. Imported
images keep dimensions and resize proportionally. Document status separates
live-draft sync from a saved version; Save version checkpoints through the
existing revision compare-and-set path. Conflicts show the preserved draft beside
the newer version with a draft backup before replacement. This preflight is not
an atomic lock; the server-side conflict protection is what holds. Assistants
editing an existing document create collaboration proposals; direct revision
APIs do not merge live edits and require `expectedRevision`.

**Presence.** An overlapping avatar stack beside the connection badge opens a
roster (name, human/tedi/external-agent kind, role, current artifact, session
count). React keys are opaque server-issued identity keys, never emails or
account ids. Motion respects `prefers-reduced-motion`.

**Route notes.**

- `/account/profile`: verified email (read-only) plus revision-guarded display
  name and avatar with upload, replace, remove, and conflict states.
- `/account/settings`: tenant-scoped browser appearance. `/admin`: tenant-wide
  operational status.
- App Store (`/explore/apps`): `xl` lane, a single-boundary overview strip,
  search plus bounded filters, compact catalog cards. It uses the API/MCP policy
  boundary and has no second catalog projection.
- Installed Apps: **Installed apps** and **Gateway connections** sections; rows
  state connection, gateway membership, and health independently and never show
  **Healthy** without a provider check. A successful protocol probe never
  implies provider or credential health. App detail shows a five-row tool
  preview; the Tools tab loads server-paged, server-searched inventory and
  always distinguishes total from filtered counts.
- Skills, run history, Run Detail, Team, tedi detail, Brain, and Compute all use
  named section headers with a one-line scope description and title-first rows
  inside one divided collection. Counts appear only after the underlying read
  succeeds; loading, refused, unavailable, truncated, stale, and unknown states
  stay explicit; unknown cost is never shown as zero.
- Brain decision rows link to run detail only for skill workflow run ids; other
  runtime run references render as non-interactive text until a matching route
  exists.
- Approval, interaction, and case queues use the `xl` width. Pending decisions
  and creation forms keep bounded cards because they carry a decision; resolved
  records collapse into a quiet collection.

Presentation changes in any of these routes must not alter query keys, scope
resolution, permissions, run or cost semantics, or detail destinations.

Do not import another app's Kumo adapters into OS, apply Cloudflare dashboard
branding directly, or make a long-lived refresh token browser-readable for an
embedded admin widget.

### Widget runtime: `apps/mcp-ui`

Use:

- `apps/mcp-ui/src/pages/[app]/r/[layout].astro` as the single generic widget
  route.
- `X-Tedix-Layout-Spec` as the preferred SSR layout-spec input (`?spec=` is a
  development fallback) and `X-Tedix-App-Theme` for app branding (API lookup is
  the direct-access fallback).
- `TedixRenderer` (`src/json-render/TedixRenderer.tsx`) for live MCP Apps
  rendering and `PreviewRenderer` (`src/components/PreviewRenderer.tsx`) for
  standalone previews.
- `WidgetWrapper` (`src/components/WidgetWrapper.tsx`) for host context, theme,
  safe area, max height, device capabilities, and error boundaries.
- `@json-render/shadcn` for standard primitives; custom components only where
  needed (`src/json-render/registry.tsx`).

Do not:

- Create one-off routes for generated widgets. Promote reusable layouts through
  `app_tools.config.layoutSpec`, `widget_key = "render"`, and the
  `ui://widgets/mcp-app/{appSlug}/r/{layoutId}.html` resource contract (see
  [MCP Apps](../mcp/apps.md)).
- Assume Tedix OS is the only host; generated UI must work in any MCP Apps
  host.
- Send raw bearer tokens into widget iframes; widget MCP calls go through the
  host bridge and Tedix-managed proxies.

### CMS and Emdash

CMS public sites are tenant-owned frontends generated from the locked Tedix
Emdash template (`apps/cms/templates/tedix`). See [CMS](../emdash/cms.md).

- `src/styles/globals.css`: locked defaults, dark-mode mechanics, editorial
  prose, Emdash block hooks.
- `src/styles/theme.css`: per-org visual customization.
- `src/layouts/Base.astro`: platform branding injection for `--color-brand-*`,
  page colors, and fonts.
- Stable hooks such as `.emdash-table`, `.emdash-code`, `.emdash-pullquote`,
  `.emdash-caption` for block styling.

Do not retheme by editing locked infrastructure files, and do not treat the
Emdash admin UI as a Kumo-adapter surface.

## Naming

- OS work surfaces: `workspace`, `tedi`, `conversation`, `session`, `run`,
  `artifact`, `approval`. OS administration: `organization`, `app`, `tool`,
  `skill`, `connection`, `setting`, `billing`.
- Widgets: `widget`, `layoutSpec`, `resource`, `host`, `structuredContent`,
  `displayMode`.
- CMS: `content`, `post`, `page`, `collection`, `theme`, `bundle`.
- Local primitives stay generic (`Shell`, `Drawer`, `Sidebar`, `Toolbar`,
  `Section`); app prefixes appear only in API boundaries, serialized data, URLs,
  and asset contracts. Direct imports; no new barrels.

## Change Rules

1. One runtime owns one pattern. Share invariants through docs and typed
   contracts, not a second frontend.
2. Delete a stale design rule when replacing it; no compatibility wording.
3. Repeated embeddable widget components move into `packages/widget-ui`;
   app-specific composition stays in the app.
4. Promote transient `ui.create_view()` output to a persisted json-render
   contract only when the layout needs reuse, QA, auditing, or MCP resource
   availability.
5. CMS retheming goes through `theme.css`, editable components, or platform
   branding.
6. Before adding a token or component, search the owning surface and extend it
   instead of creating a parallel one.
7. Visible UI changes need the surface's smoke or visual check.

## Source Map

- Tedix OS: `apps/os/src/router.tsx`, `apps/os/src/routes/`,
  `apps/os/src/components/kumo/`, `apps/os/src/styles.css`,
  `apps/os/src/kumo-tedix.css`, `apps/os/src/lib/os-query-options.ts`,
  `apps/os/src/lib/organization-theme.ts`.
- Tokens: `packages/design-tokens/src/kumo.css`,
  `packages/design-tokens/src/widget.ts`,
  `packages/design-tokens/src/widget.css`; `scripts/lint-kumo.ts`.
- Widget runtime: `apps/mcp-ui/astro.config.mjs`,
  `apps/mcp-ui/src/styles/globals.css`,
  `apps/mcp-ui/src/layouts/AppThemeLayout.astro`, and the files listed above.
- Widget UI: `packages/widget-ui/src/styles/globals.css`,
  `packages/widget-ui/src/lib/theme.ts`.
- CMS: `apps/cms/templates/tedix/src/styles/`,
  `apps/cms/templates/tedix/src/layouts/Base.astro`.
- Marketing: `apps/landing/astro.config.mjs`, `apps/landing/wrangler.jsonc`,
  `apps/landing/src/pages/`, `apps/landing/src/components/`,
  `apps/landing/src/i18n/content.ts`, and `apps/landing/DESIGN.md`.

## Related

- [Tedix OS](tedix-os.md)
- [MCP Apps](../mcp/apps.md)
- [CMS](../emdash/cms.md)
- [Architecture](../architecture.md)
