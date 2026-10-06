# @tedix/design-tokens

Shared design token vocabulary, typed widget values, and Kumo/widget CSS bridges.

## Overview

`packages/design-tokens` is the single source of truth for spacing, radius,
typography, weight, and duration values used across Tedix's product surfaces.
Typed widget values and the CSS bridges are maintained alongside each other;
tests check widget parity, the stacking ladder, and styling invariants.
The package has no runtime dependencies and works in Node, Bun, and
Cloudflare Workers builds.

This package is the exported cross-surface token source of truth: new runtime
token decisions should map back here rather than being redefined locally.

Consumers: `apps/os` (Kumo CSS), `apps/widget` (typed widget values), and
`packages/widget-ui` (typed widget bridge and CSS baseline).

## Exports

```typescript
import {
	widgetTokens,
	widgetHostCssVariables,
} from "@tedix/design-tokens/widget";
import "@tedix/design-tokens/kumo.css";
import "@tedix/design-tokens/widget.css";
```

## Usage

### Widget baseline (`./widget`, `./widget.css`)

`widgetTokens`/`widgetHostCssVariables` provide typed radius, control-height,
and icon-size scales for the embeddable widget; `widget.css` ships the same
values as a `:root` CSS custom-property block for direct stylesheet import.

### Kumo application bridge (`./kumo.css`)

`kumo.css` projects each app's Tedix palette into Kumo semantic roles and owns
the shared product font stacks plus explicit caption, label, control, body, and
dialog sizes. `apps/os` imports it after Kumo's Tailwind theme from its app-local
stylesheet; only the palette variables themselves remain app-owned.

## Related

- Runtime adapters map their platform-specific primitives back to the tokens
  exported here.
