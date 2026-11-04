import { runWorkIphone } from "./work-iphone-checks";

// iPhone 8 (375x667), light theme: forms, keyboard, lists and tap targets.
// The other sizes, themes and halves run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("375x667", "light", "flows");
