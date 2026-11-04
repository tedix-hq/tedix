import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// webkit at 1280x900, light theme: anchor routes, history restore, wheel/touch/key cancellation.
// The other engines, viewports and themes run as sibling b9-settings-anchor-*.spec.ts files.
await runSettingsAnchor("webkit", { width: 1280, height: 900 }, "light");
