import { runWorkIphone } from "./work-iphone-checks";

// iPhone 13 (390x844), dark theme: every Work route keeps its layout.
// The other sizes, themes and parts run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("390x844", "dark", "routes");
