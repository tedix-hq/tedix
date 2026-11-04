import { runWorkIphone } from "./work-iphone-checks";

// iPhone 13 (390x844), dark theme: every Work route's layout and the dense pages' view controls.
// The other sizes, themes and halves run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("390x844", "dark", "views");
