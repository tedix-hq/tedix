import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// webkit at 390x844, dark theme: anchor routes, history restore, wheel/touch/key cancellation.
// The other engines, viewports and themes run as sibling b9-settings-anchor-*.spec.ts files.
await runSettingsAnchor("webkit", { width: 390, height: 844 }, "dark");
