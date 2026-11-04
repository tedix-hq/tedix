import { runWorkHeadings } from "./work-iphone-checks";

// Feed/Deck headings on phone and desktop, dark theme
// and the desktop Capacity layout. The phone passes run as the
// work-iphone-*.spec.ts files so CI can shard them.
await runWorkHeadings("dark");
