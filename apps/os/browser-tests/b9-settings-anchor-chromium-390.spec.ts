import { runSettingsAnchor } from "./b9-settings-anchor-checks";

// chromium at 390x844, both themes: account and tedi settings pages keep one page while a chunk is pending.
// The other engines, viewports and themes run as sibling b9-settings-anchor-*.spec.ts files.
for (const theme of ["light", "dark"] as const)
	await runSettingsAnchor("chromium", { width: 390, height: 844 }, theme);
