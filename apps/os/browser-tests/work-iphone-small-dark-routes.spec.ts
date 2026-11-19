import { runWorkIphone } from "./work-iphone-checks";

// Check Work route layout at the narrowest iPhone size.
await runWorkIphone("375x667", "dark", "routes");
