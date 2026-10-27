import { runWorkIphone } from "./work-iphone-checks";

// Work on an iPhone 8 (375x667); work-iphone.spec.ts covers the iPhone 13.
await runWorkIphone(["375x667"], { desktop: false });
