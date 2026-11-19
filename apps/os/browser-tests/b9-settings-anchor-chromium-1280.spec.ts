import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// Account and tedi settings pages keep one page while a chunk is pending.
await runSettingsAnchor("chromium", { width: 1280, height: 900 }, "light");
