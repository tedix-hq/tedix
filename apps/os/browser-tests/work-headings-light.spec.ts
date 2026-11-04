import { runWorkHeadings } from "./work-iphone-checks";

// Feed/Deck headings on phone and desktop, light theme, the Office fixture read
// and the desktop Capacity layout. The phone passes run as the
// work-iphone-*.spec.ts files so CI can shard them.
await runWorkHeadings("light");
