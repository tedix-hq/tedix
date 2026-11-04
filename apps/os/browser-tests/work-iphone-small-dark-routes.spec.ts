import { runWorkIphone } from "./work-iphone-checks";

// iPhone 8 (375x667), dark theme: every Work route keeps its layout.
// The other sizes, themes and parts run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("375x667", "dark", "routes");
