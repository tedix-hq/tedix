import type { PanelApi, UpdateView } from "./api";
import { icon } from "./icons";

/**
 * The update button over the top-right corner of the main window. One click
 * applies everything there is; the app decides what that is.
 */
declare const tedixShell: PanelApi;
const root = document.getElementById("update")!;
/** The reason and Retry are showing under a failed button. */
let open = false;
let drawn = "";

function draw(view: UpdateView): void {
	if (view.kind !== "failed") open = false;
	const key = JSON.stringify([view, open]);
	if (key === drawn) return;
	drawn = key;
	document.documentElement.dataset.theme = view.dark ? "dark" : "light";
	const nodes: Node[] = [];
	if (view.kind === "available" || view.kind === "failed") {
		const failed = view.kind === "failed";
		const label = failed ? "Update did not finish" : "Update available";
		const chip = document.createElement("button");
		chip.type = "button";
		chip.className = failed ? "chip warn" : "chip";
		chip.title = label;
		chip.setAttribute("aria-label", label);
		chip.append(icon(failed ? "warning" : "download", 18));
		if (failed) chip.setAttribute("aria-expanded", String(open));
		else
			chip.append(
				Object.assign(document.createElement("span"), { className: "dot" }),
			);
		chip.onclick = () => {
			if (!failed) return void tedixShell.applyUpdate();
			open = !open;
			draw(view);
		};
		nodes.push(chip);
		if (failed && open) {
			const reason = document.createElement("p");
			reason.textContent = view.text;
			const retry = document.createElement("button");
			retry.type = "button";
			retry.className = "btn";
			retry.textContent = "Retry";
			retry.onclick = () => void tedixShell.applyUpdate();
			const pop = document.createElement("div");
			pop.className = "pop";
			pop.append(reason, retry);
			nodes.push(pop);
		}
	} else if (view.kind !== "hidden") {
		const line = document.createElement("div");
		line.className = view.kind === "working" ? "chip working" : "done";
		line.setAttribute("role", "status");
		if (view.kind === "working")
			line.append(
				Object.assign(document.createElement("span"), { className: "spinner" }),
			);
		line.append(view.text);
		nodes.push(line);
	}
	root.replaceChildren(...nodes);
	const box = root.getBoundingClientRect();
	void tedixShell.updateSize(Math.ceil(box.width), Math.ceil(box.height));
}

tedixShell.onUpdate(draw);
