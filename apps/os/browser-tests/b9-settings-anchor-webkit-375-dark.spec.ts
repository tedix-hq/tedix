import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// Mobile anchor routes, history restoration, and touch/key cancellation.
await runSettingsAnchor("webkit", { width: 375, height: 667 }, "dark");
