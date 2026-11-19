import { runWorkIphone } from "./work-iphone-checks";

// Dense pages' view controls stay tappable on a small iPhone.
await runWorkIphone("375x667", "dark", "controls");
