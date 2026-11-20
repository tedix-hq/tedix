import type { PanelApi, PanelState } from "./api";
import { icon } from "./icons";

/** The This Mac window: what runs here now, and the day-to-day switches. */
declare const tedixShell: PanelApi;
const root = document.getElementById("panel")!;
/** The machine name as typed; kept while the panel redraws every few seconds. */
let nameDraft: string | undefined;

const EXECUTOR_NAMES: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	opencode: "OpenCode",
};

type Child = Node | string | false | undefined;
function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.append(...children.filter((child): child is Node | string => !!child));
	return node;
}

function switchRow(
	title: string,
	detail: string,
	checked: boolean,
	change: (on: boolean) => void,
): HTMLElement {
	const box = el("input");
	box.type = "checkbox";
	box.setAttribute("role", "switch");
	box.checked = checked;
	box.dataset.key = title;
	box.onchange = () => change(box.checked);
	return el(
		"label",
		"switch",
		el(
			"span",
			"",
			el("span", "title", title),
			detail && el("small", "", detail),
		),
		box,
	);
}

function button(title: string, disabled: boolean, click: () => void) {
	const node = el("button", "btn", title);
	node.type = "button";
	node.disabled = disabled;
	node.dataset.key = title;
	node.onclick = click;
	return node;
}

const fact = (value: string, label: string) =>
	el("div", "fact", el("b", "", value), el("small", "", label));

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
	if (
		setup.cli.version &&
		running.some((version) => version !== setup.cli.version)
	)
		lines.push(
			`The background service still runs version ${running.join(", ")}; the command-line tool is now ${setup.cli.version}. Choose Restart runners to use it; that stops runs in progress.`,
		);
	return lines;
}

function draw(state: PanelState) {
	const { status, lastOutput, busy, openAtLogin } = state;
	const enabled = status.runners.filter((runner) => runner.enabled);
	const running = enabled.filter((runner) => runner.running).length;
	const healthy = status.cliFound && running === enabled.length;
	const nodes: Child[] = [
		el(
			"div",
			"head",
			el("span", `tile ${healthy ? "good" : "warn"}`, icon("laptop", 20)),
			el(
				"div",
				"",
				el("div", "name", status.machineName || "This Mac"),
				el(
					"div",
					`state ${healthy ? "good" : "warn"}`,
					el("span", "mark"),
					!status.cliFound
						? "Command-line tool not found"
						: status.onBattery
							? "On battery: closing the lid stops runs"
							: enabled.length === 0
								? "Does not run tasks"
								: healthy
									? "Ready for tasks"
									: `${enabled.length - running} of ${enabled.length} runners not running`,
				),
			),
		),
		el(
			"div",
			"facts",
			fact(`${running}/${enabled.length}`, "runners running"),
			fact(
				String(status.activeRuns),
				status.activeRuns === 1 ? "active run" : "active runs",
			),
			fact(status.cliVersion || "–", "command-line tool"),
		),
	];

	nodes.push(el("div", "section", "Run tasks with"));
	nodes.push(
		status.runners.length
			? el(
					"div",
					"card",
					...status.runners.map((runner) =>
						switchRow(
							EXECUTOR_NAMES[runner.executor] ?? runner.executor,
							[
								runner.organization.replace(/^org_/, ""),
								runner.enabled
									? runner.running
										? "running"
										: "not running"
									: "off",
								runner.enabled && runner.version && `version ${runner.version}`,
								runner.enabled && runner.problem,
							]
								.filter(Boolean)
								.join(" · "),
							runner.enabled,
							(on) => void tedixShell.set(runner.index, "enabled", on),
						),
					),
				)
			: el(
					"p",
					"note",
					"Tedix does not run tasks on this Mac yet. Choose Set up this Mac… to turn it on.",
				),
	);

	const serving = status.servingIndex;
	const options: Child[] = [];
	if (serving !== undefined) {
		const name = el("input");
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
		options.push(
			el("label", "field", el("span", "", "Machine name"), name),
			switchRow(
				"Let tedis edit files and run commands",
				`A tedi is a Tedix agent. Its requests are ${status.machineToolsUp ? "being answered" : "not being answered"} on this Mac.`,
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
	if (openAtLogin !== undefined)
		options.push(
			switchRow(
				"Open Tedix at login",
				"",
				openAtLogin,
				(on) => void tedixShell.openAtLogin(on),
			),
		);
	if (options.length)
		nodes.push(el("div", "section", "This Mac"), el("div", "card", ...options));

	const notes = [...status.notes, ...serviceLines(state), lastOutput].filter(
		Boolean,
	);
	nodes.push(
		el(
			"div",
			"buttons",
			button("Restart runners", busy, () => void tedixShell.action("restart")),
			button(
				"Set up this Mac…",
				false,
				() => void tedixShell.action("setup-window"),
			),
		),
		notes.length > 0 &&
			el("div", "notes", ...notes.map((note) => el("small", "", note))),
	);

	const active = document.activeElement;
	if (active instanceof HTMLInputElement && active.type === "text") return;
	const focused = (active as HTMLElement | null)?.dataset?.key;
	root.replaceChildren(
		...nodes.filter((node): node is Node | string => !!node),
	);
	if (focused)
		[...document.querySelectorAll<HTMLElement>("[data-key]")]
			.find((node) => node.dataset.key === focused)
			?.focus();
}

tedixShell.onState(draw);
void tedixShell.state().then(draw);
