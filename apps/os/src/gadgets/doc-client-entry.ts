import { mountDocClient, type DocClientBridge } from "./doc-client";

declare global {
	interface Window {
		tedix: DocClientBridge;
	}
}
const root = document.getElementById("app")!;
void mountDocClient(root, window.tedix).catch((error) => {
	root.textContent =
		error instanceof Error ? error.message : "Doc could not open";
});
