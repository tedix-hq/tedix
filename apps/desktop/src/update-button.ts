import type { PanelApi, UpdateView } from "./api";
import { icon } from "./icons";

/**
 * The update entry at the bottom left of the main window. A click hands
 * over to the app, which asks what it must ask in a native dialog.
 */
declare const tedixShell: PanelApi;
const root = document.getElementById("update")!;
const workingLine = document.createElement("div");
workingLine.className = "entry working";
workingLine.setAttribute("role", "status");
const workingText = document.createElement("span");
workingText.className = "text";
workingLine.append(
	Object.assign(document.createElement("span"), { className: "spinner" }),
	workingText,
);
let drawn = "";

function draw(view: UpdateView): void {
	const key = JSON.stringify(view);
	if (key === drawn) return;
	drawn = key;
	document.documentElement.dataset.theme = view.dark ? "dark" : "light";
	root.dataset.place = view.place;
	const nodes: Node[] = [];
	if (view.kind === "working") {
		workingLine.title = view.label;
		workingText.textContent = view.text;
		workingText.hidden = view.place === "rail";
		if (view.place === "rail")
			workingLine.setAttribute("aria-label", view.label);
		else workingLine.removeAttribute("aria-label");
		nodes.push(workingLine);
	} else if (view.kind === "done") {
		const line = document.createElement("div");
		line.className = "entry done";
		line.setAttribute("role", "status");
		line.title = view.label;
		line.append(icon("check", 16));
		if (view.place !== "rail")
			line.append(
				Object.assign(document.createElement("span"), {
					className: "text",
					textContent: view.text,
				}),
			);
		else line.setAttribute("aria-label", view.label);
		nodes.push(line);
	} else if (view.kind !== "hidden") {
		const entry = document.createElement("button");
		entry.type = "button";
		entry.className = view.kind === "failed" ? "entry warn" : "entry";
		entry.title = view.label;
		entry.setAttribute("aria-label", view.label);
		entry.append(icon(view.kind === "failed" ? "warning" : "refresh", 16));
		if (view.place !== "rail")
			entry.append(
				Object.assign(document.createElement("span"), {
					className: "text",
					textContent: view.text,
				}),
				icon("arrow", 14),
			);
		entry.onclick = () => void tedixShell.applyUpdate();
		nodes.push(entry);
	}
	// Leaving the spinner attached preserves its animation during progress updates.
	if (view.kind !== "working" || workingLine.parentElement !== root)
		root.replaceChildren(...nodes);
	const box = root.getBoundingClientRect();
	void tedixShell.updateSize(Math.ceil(box.width), Math.ceil(box.height));
}

tedixShell.onUpdate(draw);
