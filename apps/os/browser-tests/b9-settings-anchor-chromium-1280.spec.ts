import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// chromium at 1280x900, both themes: account and tedi settings pages keep one page while a chunk is pending.
// The other engines, viewports and themes run as sibling b9-settings-anchor-*.spec.ts files.
for (const theme of ["light", "dark"] as const)
	await runSettingsAnchor("chromium", { width: 1280, height: 900 }, theme);
