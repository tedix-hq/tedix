import { runWorkIphone } from "./work-iphone-checks";

// iPhone 8 (375x667), light theme: every Work route's layout and the dense pages' view controls.
// The other sizes, themes and halves run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("375x667", "light", "views");
