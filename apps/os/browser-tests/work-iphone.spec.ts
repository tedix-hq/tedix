import { runWorkIphone } from "./work-iphone-checks";

// Feed/Deck headings, Office and Capacity, then Work on an iPhone 13. The
// iPhone 8 pass runs as work-iphone-small.spec.ts so CI can shard the two.
await runWorkIphone(["390x844"], { desktop: true });
