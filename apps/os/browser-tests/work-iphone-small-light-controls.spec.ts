import { runWorkIphone } from "./work-iphone-checks";

// iPhone 8 (375x667), light theme: the dense pages' view controls are tappable.
// The other sizes, themes and parts run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("375x667", "light", "controls");
