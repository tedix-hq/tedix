import { mountSlidesClient, type SlidesClientBridge } from "./slides-client";

const root = document.getElementById("app")!;
const bridge = (window as unknown as { tedix: SlidesClientBridge }).tedix;
void mountSlidesClient(root, bridge).catch((error) => {
	root.textContent =
		error instanceof Error ? error.message : "Slides could not open";
});
