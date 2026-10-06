# @tedix/widget-ui

> UI components for embedded Tedix widgets.

Shared UI component package for building Apps SDK widgets with Tedix.
`apps/mcp-ui` consumes its json-render components and MCP Apps integration.

## Quick Start

```css
/* globals.css - import order matters */
@import "tailwindcss";
@import "@tedix/widget-ui/globals.css";
```

```tsx
import { ComparisonLayout } from "@tedix/widget-ui/layouts";
import { Button } from "@tedix/widget-ui/button";
```

## Exported surface

- **Components** — `alert`, `badge`, `button`, `card`, `carousel`, `dialog`,
  `generated-chart`, `separator`, `table`
- **Layouts** — `layouts` (ComparisonLayout and layout types)
- **Lib** — `safe-url`, `theme`, `design-tokens`
- **Styles** — `globals.css`

The framework-neutral personal-Tedi embed is app-owned under
`apps/widget/src/embed/ui`; it is not part of this React component package.

Additional internal components (avatar, chart, chip, image, input,
photo-carousel, skeleton, comparison/_, layout-primitives/_,
and the shared `lib/` utilities) remain in `src/` because the exported surface
composes them; they are not public entrypoints.

## Testing

```bash
bun run type-check
bun run test:run
```
