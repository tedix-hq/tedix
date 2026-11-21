import { cliUpdateLine, type PanelApi, type PanelState } from "./api";
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

const fact = (label: string, value: string) =>
	el("div", "line", el("span", "", label), el("b", "", value));

/** One line when the runners run another version than the one in use. */
function serviceLine({ status, setup }: PanelState): string {
	const running = [
		...new Set(
			status.runners
				.filter((runner) => runner.enabled && runner.version)
				.map((runner) => runner.version!),
		),
	];
	const { version } = setup.cli;
	return version && running.some((runs) => runs !== version)
		? `The runners still run ${running.join(", ")}. Restart runners to use ${version}.`
		: "";
}

function draw(state: PanelState) {
	const { status, lastOutput, busy, openAtLogin } = state;
	const enabled = status.runners.filter((runner) => runner.enabled);
	const running = enabled.filter((runner) => runner.running).length;
	const healthy = status.cliFound && running === enabled.length;
	const problem = !status.cliFound
		? "Command-line tool not found"
		: !healthy
			? `${enabled.length - running} of ${enabled.length} runners not running`
			: "";
	const nodes: Child[] = [
		el(
			"div",
			"head",
			el("span", `tile ${healthy ? "good" : "warn"}`, icon("laptop", 20)),
			el(
				"div",
				"",
				el("div", "name", status.machineName || "This Mac"),
				// Speak up only when something needs attention.
				problem && el("div", "state warn", el("span", "mark"), problem),
			),
		),
		el(
			"div",
			"card",
			fact("Runners", `${running} of ${enabled.length} running`),
			fact("Active runs", String(status.activeRuns)),
			fact(
				"Command-line tool",
				[
					status.cliVersion || "–",
					state.setup.cli.other && `${state.setup.cli.other} kept`,
				]
					.filter(Boolean)
					.join(" · "),
			),
		),
	];

	const restart = () =>
		button("Restart runners", busy, () => void tedixShell.action("restart"));
	const down = state.setup.cli.update;
	if (down?.down && !state.setup.cli.updating)
		nodes.push(el("div", "problem", el("p", "", down.text), restart()));
	if (state.setup.cli.access)
		nodes.push(
			el(
				"div",
				"problem soft",
				el("p", "", state.setup.cli.access),
				button(
					"Open System Settings",
					false,
					() => void tedixShell.open("folder-access"),
				),
			),
		);

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
			: el("p", "note", "No runners yet."),
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
				status.machineToolsUp ? "Answering requests" : "Not answering requests",
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

	const { cli } = state.setup;
	const notes = [
		...status.notes,
		serviceLine(state),
		cliUpdateLine(cli),
		lastOutput,
	].filter(Boolean);
	nodes.push(
		el(
			"div",
			"buttons",
			restart(),
			cli.other &&
				button(
					`Go back to version ${cli.other}`,
					busy || !!cli.updating,
					() => void tedixShell.action("cli-back"),
				),
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
