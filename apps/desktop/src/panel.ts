import type { PanelApi, PanelState } from "./api";

declare const tedixShell: PanelApi;
const root = document.getElementById("panel")!;
/** The machine name as typed; kept while the panel redraws every few seconds. */
let nameDraft: string | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text = "",
	className = "",
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.textContent = text;
	node.className = className;
	return node;
}

function toggle(
	title: string,
	detail: string,
	checked: boolean,
	change: (on: boolean) => void,
): HTMLElement {
	const label = element("label");
	const box = element("input");
	box.type = "checkbox";
	box.checked = checked;
	box.onchange = () => change(box.checked);
	const text = element("span", title);
	if (detail) text.append(element("small", detail));
	label.append(box, text);
	return label;
}

function button(title: string, disabled: boolean, click: () => void) {
	const node = element("button", title);
	node.disabled = disabled;
	node.onclick = click;
	return node;
}

/**
 * Which version the background service runs, and a plain line when that is
 * not the version `~/.local/bin/tedix` now is.
 */
function serviceLines({ status, setup }: PanelState): string[] {
	const running = [
		...new Set(
			status.runners
				.filter((runner) => runner.enabled && runner.version)
				.map((runner) => runner.version!),
		),
	];
	const lines = setup.cli.service ? [setup.cli.service] : [];
	if (running.length)
		lines.push(`Background service runs version ${running.join(", ")}.`);
	if (
		setup.cli.version &&
		running.some((version) => version !== setup.cli.version)
	)
		lines.push(
			`The command-line tool is now ${setup.cli.version}. Choose Restart runners to use it; that stops runs in progress.`,
		);
	return lines;
}

function draw(state: PanelState) {
	const { status, summary, lastOutput, busy, openAtLogin } = state;
	const nodes: HTMLElement[] = [
		element("h1", summary, status.onBattery ? "warning" : ""),
	];
	nodes.push(
		element(
			"p",
			`Machine tools: ${status.machineToolsUp ? "running" : "not running"}${status.machineToolsEvent ? ` · last event ${status.machineToolsEvent}` : ""}`,
		),
		...status.notes.map((note) => element("p", note, "quiet")),
		...serviceLines(state).map((line) => element("p", line, "quiet")),
		element("hr"),
	);

	for (const runner of status.runners) {
		const detail = runner.enabled
			? [
					runner.running ? "running" : "not running",
					runner.version && `on ${runner.version}`,
					runner.problem,
				]
					.filter(Boolean)
					.join(" · ")
			: "off";
		nodes.push(
			toggle(
				`${runner.executor} · ${runner.organization}`,
				detail,
				runner.enabled,
				(on) => void tedixShell.set(runner.index, "enabled", on),
			),
		);
	}
	if (!status.runners.length)
		nodes.push(
			element(
				"p",
				"Tedix does not run tasks on this Mac yet. Choose Set up this Mac… to turn it on.",
				"quiet",
			),
		);

	const serving = status.servingIndex;
	if (serving !== undefined) {
		const name = element("input");
		name.type = "text";
		name.placeholder = "Machine name";
		name.maxLength = 100;
		name.value = nameDraft ?? status.machineName;
		name.oninput = () => {
			nameDraft = name.value;
		};
		name.onchange = () => {
			nameDraft = undefined;
			void tedixShell.set(
				serving,
				"machineName",
				name.value.trim() || undefined,
			);
		};
		nodes.push(
			element("hr"),
			name,
			toggle(
				"Let tedis edit files and run commands on this Mac",
				"",
				status.machineWrite,
				(on) =>
					void tedixShell.set(
						serving,
						"machineWriteMode",
						on ? "allow" : "off",
					),
			),
		);
	}

	const commands = element("p");
	commands.append(
		button("Restart runners", busy, () => void tedixShell.action("restart")),
		button(
			"Set up this Mac…",
			false,
			() => void tedixShell.action("setup-window"),
		),
	);
	nodes.push(element("hr"), commands);
	if (lastOutput) nodes.push(element("p", lastOutput, "quiet"));

	if (openAtLogin !== undefined)
		nodes.push(
			toggle(
				"Open at login",
				"",
				openAtLogin,
				(on) => void tedixShell.openAtLogin(on),
			),
		);

	const typing =
		document.activeElement instanceof HTMLInputElement &&
		document.activeElement.type === "text";
	if (!typing) root.replaceChildren(...nodes);
}

tedixShell.onState(draw);
void tedixShell.state().then(draw);
