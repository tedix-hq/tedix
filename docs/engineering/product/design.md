---
summary: "Cross-surface design-system decisions, UI runtime ownership, tokens, and component rules"
read_when:
  - Updating Tedix OS, widget, landing, or CMS UI behavior
  - Choosing the correct UI owner and component system
  - Adding a token, component adapter, or page layout
title: "Design system"
---

# Tedix Design System

The cross-surface design decisions for Tedix. When code and this page diverge,
fix one of them in the same change. Kumo adapter mechanics and lint gates are in
`apps/os/AGENTS.md`; landing composition is in `apps/landing/DESIGN.md`.

## UI Runtimes And Owners

Tedix has several UI runtimes. They share tokens and contracts, not components.

| Runtime                   | Owner                    | Contract                                                                                       |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| Tedix OS                  | `apps/os`                | The only product frontend; Tedix tokens over app-local Kumo adapters (`src/components/kumo/`)  |
| MCP Apps / widget runtime | `apps/mcp-ui`            | Astro SSR + React islands, json-render, `@tedix/widget-ui`; must work in any MCP Apps host     |
| Embedded host widget      | `apps/widget`            | Framework-neutral Shadow DOM; sandboxed tool projections loaded from `apps/mcp-ui`             |
| CMS public sites          | `apps/cms/templates/*`   | Locked infrastructure; per-org retheming only via `src/styles/theme.css` and platform branding |
| Marketing site            | `apps/landing`           | App-local pages and styles                                                                     |
| Shared widget components  | `packages/widget-ui`     | Embeddable widget primitives, composites, layouts; not an OS component package                 |
| Shared tokens             | `packages/design-tokens` | Typed tokens for OS (via the Kumo bridge `kumo.css`) and widgets (`widget.css`), parity-tested |

Do not import another app's Kumo adapters into OS, retheme a CMS site by editing
locked files, or treat the Emdash admin UI as a Kumo surface. Widget iframes
never receive raw bearer tokens; their MCP calls go through the host bridge.

## Tedix OS Product Character

Tedix OS is a quiet command center for digital workers: calm enough for daily
business work, precise enough to trust with permissions, budgets, and live
systems. It is not an analytics dashboard, a developer console with chat added,
or a wall of interchangeable cards. Every primary view answers, in order: what
needs attention, what is working now, what changed, why, where the record is,
and what the operator can safely do next.

Progressive disclosure runs `outcome -> current state -> rationale -> record ->
machine detail`:

- Outcome copy uses the operator's language, not a transport, queue, or table
  name. State is short and categorical (`queued`, `working`, `blocked`,
  `awaiting approval`, `completed`, `failed`).
- Long reasoning, tool calls, and raw events stay collapsed until requested.
  Permission, budget, and provenance sit beside the action they qualify.
- IDs use mono type and are never the primary label when a human name exists.
- Status color is sparse: shape, icon, and label carry meaning without color.
  The organization accent marks selection, progress, links, and the primary
  action only. Primary actions use the theme's `--primary-foreground`; never
  force a white label.

### Page archetypes

Choose one before composing a route; width comes from the `Page` lanes in
`apps/os/src/components/kumo/page.tsx`.

| Archetype                 | Use for                                  | Lane          | Required behavior                                                 |
| ------------------------- | ---------------------------------------- | ------------- | ----------------------------------------------------------------- |
| Operational table         | Queues, runs, outputs, connections       | `xl` / `full` | One bounded toolbar; rows without card chrome; detail keeps list  |
| Master-detail inspector   | Work Items, runs, approvals, apps, tedis | `lg` / `xl`   | Summary stays visible while the inspector discloses progressively |
| System canvas             | Workspace, topology, live collaboration  | `bleed`       | Canvas earns edge-to-edge space; overlays are explicit layers     |
| Conversation and artifact | Chat, documents, sheets, slides          | `bleed`       | Peer panes, not nested cards; approvals keep a visible boundary   |
| Operational overview      | Work queue and domain landing pages      | `lg`          | Ready work leads; metrics only when they change a decision        |
| Settings / forms          | Settings, focused detail                 | `md`          | Single lane, named sections, sticky rail with one `aria-current`  |

`Page` owns the gutters (16px phone, 24px from `sm`, 40px desktop); routes never
override its padding. Detail shells compose `PageBack`, `PageHeading`, and
`PageMeta`, and the back control restores the list context.

### Composition rules

- One dominant primary action per section or modal; destructive actions stay
  isolated and use danger color only on title, action, and confirmation.
- At most three surface levels: canvas, bounded surface, overlay. A card needs
  selection, independent scrolling, elevation, or a real object boundary, not
  just a heading. Never repeat the page title inside the first card.
- Filters sit next to their data in `PageToolbar`; search uses `SearchInput`
  with counts in its trailing addon. Read-only summaries render as one divided
  `Collection`; metrics use `MetricGrid`; entity icons use `IconFrame`; empty
  states use `Empty` and name the single best next action.
- Inventory rows carry at most two categorical badges. Separate facts
  (availability, credentials, installation, protocol health) never collapse
  into a generic `Healthy`, and a protocol probe never implies provider health.
- Dense tables keep their shape where columns fit; below that breakpoint provide
  a `Collection` projection with the same identity, status, and actions.
  Responsive reduction never changes links, mutations, or authorization.
- Motion communicates progress, arrival, or a changed layer; idle surfaces do
  not glow, float, or pulse.

## Tokens

Use semantic tokens first; never hardcode a color, radius, or font stack a
surface already exposes. New shared decisions map back to
`packages/design-tokens`.

### Spacing and typography

- Layout spacing is 4px-based (`4`–`32`); the half steps in
  `@tedix/design-tokens` are component geometry, not layout gaps.
- Kumo roles from `kumo.css`: `caption` 11/16, `label` 12/16, `control` 13/18,
  `body` 14/20, `section` 16/22, `dialog` 18/24. Compact 28–32px controls use
  `control`; standard 36–40px controls use `body`; badges `label`; dialog,
  sheet, and prominent empty-state titles use `dialog`. Hover never changes
  weight; letter spacing is `0` except label/status metadata.

### Radii

OS uses two tiers so a card reads as a layer above its controls:

- **Top-level surfaces — 12px** (`--radius-xl`): cards and panels on the
  canvas, via the `Card` and `Surface` adapters, which override Kumo's default.
- **Controls and nested wells — 8px** (`--radius`): buttons, inputs, tabs,
  badges, and any bounded region inside a card. `Surface` defaults to
  `tier="well"`; `tier="panel"` is the deliberate promotion.
- Move the card tier at the adapter or `--radius-xl`, never by bumping
  `--radius`, which shifts the whole control ladder. Kumo components with their
  own fixed geometry (overlays, code blocks) keep it. Widget, landing, and CMS
  radii stay local.

### Control density

- Heights: 24px extra-small, 28px compact, 32px compact icon-only, 36px
  standard, 40px large. Feature pages choose `size`, never restyle height.
- Touch targets key off pointer capability: the `coarse:` variant
  (`@media (pointer: coarse)`) in `apps/os/src/styles.css` sets 44px floors;
  `sm:`/`md:` are for layout only. Under coarse pointers text inputs are floored
  to 16px so iOS Safari does not zoom (an `!important` exception, because the
  type roles are themselves important).
- Selected tabs and segments use `bg-kumo-tint` inside one group boundary, with
  no second ring or shadow. Navigation rails scroll horizontally; never wrap.
- `100dvh` does not shrink for a software keyboard: full-height shells size from
  `--viewport-tedix-*` (`apps/os/src/lib/viewport-metrics.ts`). Dialogs become
  bottom sheets below 768px wide or 520px tall.

### Elevation, borders, and motion

Operational content is flat; elevation marks a changed layer, never importance.

- `shadow-tedix-raised` for raised canvases, `-floating` for anchored menus and
  popovers, `-overlay` for sheets and dialogs. No glow, backdrop blur, or hover
  lift on rows or cards. Artifact depth is reserved for paper, slides, and
  media frames.
- `border-kumo-hairline` separates rows; `border-kumo-line` encloses a real
  surface. Never stack border, ring, and shadow on one selected item.
- `Card`/`Surface` own background, border, radius, padding, and elevation; call
  sites own layout only. Tables are flat rows with hairlines, no zebra stripes.
- Motion uses `tedix-fast` (100ms), `tedix-standard` (150ms), or
  `tedix-structural` (200ms) on explicit properties, never `transition-all`.
  OS honors `prefers-reduced-motion` and an operator motion preference.

### Stacking

The z-index ladder is `--tedix-layer-*` in `packages/design-tokens/src/kumo.css`
(`overlay` 100, `dropdown` 200, `tooltip` 300, `toast` 1000 mirroring Kumo,
`immersive` 1100). Write `z-(--tedix-layer-dropdown)`, never a literal; only
in-flow sticky chrome inside its own scroller uses local `z-10` or below.

- **The layer goes on the positioner, not the popup.** Base UI positions
  anchored popups with a transform on the positioner, which creates a stacking
  context. Sheet has no positioner and carries the layer on backdrop and popup.
- **Keep `isolate` on the Select positioner.** With `alignItemWithTrigger` Base
  UI drops the transform, and `isolation: isolate` is what contains its sticky
  scroll buttons.
- Dialog mounts into an isolated portal host (`kumo/layer-portal.ts`) so nested
  anchored controls sit above it without call-site z-indexes.

### Colors

- OS maps the Tedix OKLCH palette into Kumo semantic variables. The bridge is
  name-matched with no compile-time check (`lint:kumo` guards it). Tokens Kumo
  declares on a component root (for example `--kumo-code-highlight-bg` on
  `.kumo-shiki`) must be matched on that selector.
- Raw Tailwind palette utilities are rejected in `apps/os/src` because they
  ignore the tenant palette; use semantic tokens or `--tedix-hue-*`.
- **Neutral ladder.** Dark canvas is OKLCH `0.10`; surfaces climb away from it
  (elevated `0.12`, recessed `0.15`, card `0.17`, control `0.205`,
  tint/hairline `0.269`, line `0.32`, interactive `0.371`). Light mode inverts:
  shell tones recede below the canvas and cards lift to white with shadow. A
  collapsed ladder (canvas-on-canvas cards) is the failure mode. Links and focus
  use `#4693ff` dark and `#1267c4` light for AA contrast.

### Tenant OS appearance

Organization admins may publish a constrained appearance profile
(`OrganizationOsThemeSchema` in `packages/api-contract/src/schemas/organization.ts`):
light/dark accent, background, foreground, surface contrast, and allowlisted
fonts. It never carries arbitrary CSS, classes, or font URLs; color pairs are
contrast-validated at the API, and secondary surfaces are derived with
`color-mix()`. Operators still own mode, density, motion, and high contrast.

- `apps/os/src/lib/organization-theme.ts` compiles the profile; `contrast`
  scales the ladder and never reorders it.
- **High contrast is a compiler input.** The profile writes inline styles on
  `<html>`, which outrank `:root[data-contrast="high"]`, so the compiler takes
  the flag and floors hairline, control edge, and secondary text. Keep it in
  agreement with the untenanted block in `apps/os/src/styles.css`.
- `color-scheme` comes from the same luminance test that selects the ladder,
  because every `light-dark()` in the bridge resolves off it.
- A per-origin browser cache only avoids a first-paint flash; the server value
  replaces it after hydration.

## Tedix OS Surfaces

Work is the tenant root route; a Workspace is `/workspace/{uuid}`. Neither is
an iframe; opaque sandbox frames remain the boundary for untrusted previews and
MCP Apps widgets. Generated oRPC query options
(`apps/os/src/lib/os-query-options.ts`) own query keys, and presentation changes
must never alter query keys, permissions, cost semantics, or link destinations.
See [Tedix OS](tedix-os.md).

- **Shell.** Kumo rail, 260px expanded / 56px collapsed; `Cmd/Ctrl+K` opens the
  command palette everywhere.
- **Workspace workbench.** A 56px header replaces the rail; chat keeps a
  resizable column beside the workpiece; the resource workbench stays mounted
  while Work is selected. Running/waiting labels require a live, unexpired
  Attempt. Output modes are **Document**, **Sheet**, **Slides**, **Video**.
- **Output surfaces.** Documents render as a fixed-light page on a recessed
  `--tedix-desk` with a 48rem prose measure. The paper stays light because the
  editor is the export surface: `apps/api/src/lib/os-output-html.ts` renders
  PDF/PNG on white with the author's stored colors, so a dark editor would let
  users pick ink that vanishes on export. Slides use a rounded 16:9 canvas on a
  fixed-light stage (not `--tedix-desk`). Read views reuse their editor's
  chrome so a revision and its draft look like the same object. Editor toolbars
  are one scrollable row grouped by hairlines.
- **Native documents.** Save version checkpoints through the revision
  compare-and-set path; the UI conflict preflight is not a lock. Assistants
  editing an existing document create collaboration proposals; direct revision
  APIs require `expectedRevision`.
- **Presence** uses opaque server-issued identity keys, never emails or ids.
- Counts appear only after the underlying read succeeds; refused, truncated,
  stale, and unknown states stay explicit, and unknown cost is never zero.

## Widget Runtime

`apps/mcp-ui/src/pages/[app]/r/[layout].astro` is the single generic widget
route; `TedixRenderer` renders live MCP Apps and `WidgetWrapper` owns host
context, theme, and error boundaries. Do not create one-off routes for
generated widgets: promote reusable layouts through `app_tools.config.layoutSpec`
and the `ui://widgets/mcp-app/{appSlug}/r/{layoutId}.html` resource contract
([MCP Apps](../mcp/apps.md)). Widget host hooks stay in `apps/mcp-ui`; widget-ui
layouts receive props and callbacks.
