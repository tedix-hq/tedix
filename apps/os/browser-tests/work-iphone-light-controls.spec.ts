import { runWorkIphone } from "./work-iphone-checks";

// iPhone 13 (390x844), light theme: the dense pages' view controls are tappable.
// The other sizes, themes and parts run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("390x844", "light", "controls");
