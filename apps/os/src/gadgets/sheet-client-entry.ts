import { mountSheetClient, type SheetClientBridge } from "./sheet-client";
const root = document.getElementById("app")!;
void mountSheetClient(
	root,
	(window as Window & { tedix: SheetClientBridge }).tedix,
).catch((error) => {
	root.textContent =
		error instanceof Error ? error.message : "Sheet could not open";
});
