import type { PanelApi, PanelState } from "./api";

declare const tedixShell: PanelApi;
const line = document.getElementById("status")!;
const host = document.getElementById("host")!;

for (const name of ["back", "forward", "reload", "open-panel"] as const)
	document.getElementById(name)!.onclick = () => void tedixShell.action(name);
line.onclick = () => void tedixShell.action("open-panel");

function draw(state: PanelState) {
	line.textContent = state.summary;
	line.className = state.status.onBattery ? "warning" : "";
	host.textContent = state.host;
}

tedixShell.onState(draw);
void tedixShell.state().then(draw);
