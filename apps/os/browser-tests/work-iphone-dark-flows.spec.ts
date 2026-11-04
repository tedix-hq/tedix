import { runWorkIphone } from "./work-iphone-checks";

// iPhone 13 (390x844), dark theme: forms, keyboard, lists and tap targets.
// The other sizes, themes and halves run as sibling work-iphone-*.spec.ts files.
await runWorkIphone("390x844", "dark", "flows");
