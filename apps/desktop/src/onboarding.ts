import type { PanelApi, PanelState } from "./api";
import type { StepRun, ToolRow } from "./setup";

/** The Set up this Mac window: one step per screen, drawn from the state the app sends. */
declare const tedixShell: PanelApi;
const rail = document.getElementById("rail")!;
const screen = document.getElementById("screen")!;

const CONNECTOR_URL = "https://connect.mcp.tedix.dev/mcp";
const EXECUTOR_NAMES: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	opencode: "OpenCode",
	"any-local": "any coding tool",
};
const STEPS = [
	["welcome", "Welcome"],
	["sign-in", "Sign in"],
	["cli", "Command-line tool"],
	["tools", "Coding tools"],
	["chat", "Chat apps"],
	["tasks", "Run tasks"],
	["ready", "Ready"],
] as const;
type StepId = (typeof STEPS)[number][0];

let state: PanelState | undefined;
let current: StepId | undefined;
let drawn: StepId | undefined;
/** Screens with nothing to tick off count as done once seen. */
const seen = new Set<StepId>();

type Child = HTMLElement | string | false | undefined;
function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.append(
		...children.filter((child): child is HTMLElement | string => !!child),
	);
	return node;
}

function button(
	label: string,
	kind: "primary" | "plain" | "quiet",
	click: () => void,
	disabled = false,
): HTMLButtonElement {
	const node = el("button", `btn ${kind === "plain" ? "" : kind}`, label);
	node.type = "button";
	node.disabled = disabled;
	node.dataset.key = label;
	node.onclick = click;
	return node;
}

const act = (action: Parameters<PanelApi["setup"]>[0], id?: string) =>
	void tedixShell.setup(action, id);

/** What an action is doing or how it ended: live line, result, or the reason with Retry. */
function progress(ran: StepRun | undefined, retry: () => void): Child[] {
	if (!ran) return [];
	if (ran.working) {
		const address = ran.address;
		return [
			el("div", "live", el("span", "spinner"), ran.working),
			address &&
				el(
					"div",
					"row",
					el(
						"span",
						"note",
						"If your browser did not open, copy the address and open it yourself.",
					),
					button("Copy address", "plain", () => void tedixShell.copy(address)),
				),
		];
	}
	if (ran.error) {
		const details = ran.details ?? ran.error;
		return [
			el("div", "error", ran.error),
			el(
				"div",
				"row",
				button("Retry", "plain", retry),
				button("Copy details", "quiet", () => void tedixShell.copy(details)),
			),
		];
	}
	return ran.done ? [el("div", "done-line", `✓ ${ran.done}`)] : [];
}

function toolsDone(tools: ToolRow[]): boolean {
	const usable = tools.filter(
		(tool) => tool.found === "found" && (tool.canAdd || tool.tedix === "added"),
	);
	return usable.length > 0 && usable.every((tool) => tool.tedix === "added");
}

function isDone(id: StepId, { setup, status }: PanelState): boolean {
	if (id === "sign-in") return setup.signedIn;
	if (id === "cli") return setup.cli.kind !== "missing";
	if (id === "tools") return toolsDone(setup.tools);
	if (id === "tasks") return status.runners.some((runner) => runner.enabled);
	if (id === "ready") return !setup.open && setup.reach === "ok";
	return seen.has(id);
}

/** Where the window starts: the first step that still needs something, else the summary. */
function firstOpen(now: PanelState): StepId {
	if (!now.setup.signedIn && now.setup.cli.kind !== "missing" && !seen.size)
		return "welcome";
	for (const id of ["cli", "sign-in", "tools", "tasks"] as const)
		if (!isDone(id, now)) return id;
	return "ready";
}

interface Screen {
	title: string;
	lead: string;
	content: Child[];
	/** The bottom-right button; Return presses it. */
	primary: { label: string; click: () => void; disabled?: boolean };
	skip?: boolean;
}

function go(id: StepId): void {
	if (current) seen.add(current);
	current = id;
	draw();
}
const next = () => {
	const at = STEPS.findIndex(([id]) => id === current);
	if (at < STEPS.length - 1) go(STEPS[at + 1]![0]);
};
const back = () => {
	const at = STEPS.findIndex(([id]) => id === current);
	if (at > 0) go(STEPS[at - 1]![0]);
};

function point(icon: string, title: string, detail: string): HTMLElement {
	return el(
		"li",
		"",
		el("span", "badge", icon),
		el("div", "", title, el("small", "", detail)),
	);
}

function toolCard(tool: ToolRow, steps: Record<string, StepRun>): HTMLElement {
	if (tool.found === "absent")
		return el(
			"div",
			"card absent",
			el("span", "badge", tool.name[0]),
			el(
				"div",
				"",
				el("div", "name", tool.name),
				el("div", "state", "Not found on this Mac"),
			),
		);
	const adding = steps[`add:${tool.id}`];
	const connecting = steps[`connect:${tool.id}`];
	const ran =
		adding?.working || adding?.error ? adding : (connecting ?? adding);
	const busy = Boolean(ran?.working);
	const stateLine =
		tool.found === "no-command"
			? "Command not found"
			: tool.tedix === "added"
				? "Tedix is added"
				: tool.tedix === "missing"
					? "Tedix is not added yet"
					: tool.tedix === "checking"
						? "Checking…"
						: "Found";
	// One button: the next thing this tool needs.
	const action =
		tool.canAdd && tool.tedix === "missing"
			? button("Add Tedix", "plain", () => act("add", tool.id), busy)
			: tool.canSignIn
				? button(
						"Connect in browser",
						"plain",
						() => act("connect", tool.id),
						busy,
					)
				: undefined;
	const note = [tool.note, tool.signInSay].filter(Boolean).join(" ");
	const below = [
		note && !ran?.working && !ran?.error && el("div", "note", note),
		...progress(ran, () =>
			act(ran === connecting ? "connect" : "add", tool.id),
		),
	].filter(Boolean);
	return el(
		"div",
		"card",
		el("span", "badge", tool.name[0]),
		el(
			"div",
			"",
			el("div", "name", tool.name),
			el("div", `state ${tool.tedix === "added" ? "ok" : ""}`, stateLine),
		),
		el("div", "actions", action),
		below.length > 0 && el("div", "below", ...below),
	);
}

function switchRow(
	title: string,
	detail: string,
	checked: boolean,
	change: (on: boolean) => void,
	disabled = false,
): HTMLElement {
	const box = el("input");
	box.type = "checkbox";
	box.setAttribute("role", "switch");
	box.checked = checked;
	box.disabled = disabled;
	box.dataset.key = title;
	box.onchange = () => change(box.checked);
	return el(
		"label",
		"switch",
		el("span", "", title, el("small", "", detail)),
		box,
	);
}

/** Which version the background service runs, and whether it is the linked one. */
function serviceVersion({ status, setup }: PanelState): string[] {
	const running = [
		...new Set(
			status.runners
				.filter((runner) => runner.enabled && runner.version)
				.map((runner) => runner.version!),
		),
	];
	return [
		setup.cli.service,
		running.length > 0 &&
			`The background service runs version ${running.join(", ")}.`,
		running.some((version) => version !== setup.cli.version) &&
			"That is not the version above. Choose Restart runners in Tedix → This Mac… to use it; that stops tasks that are running.",
	].filter((line): line is string => Boolean(line));
}

function screenFor(id: StepId, now: PanelState): Screen {
	const { setup, status } = now;
	const steps = setup.steps;
	const cli = setup.cli;
	const continueButton = { label: "Continue", click: next };

	if (id === "welcome")
		return {
			title: "Set up this Mac for Tedix",
			lead: "A few short steps. You can stop at any point and come back from the Tedix menu.",
			content: [
				el(
					"ul",
					"points",
					point(
						"⌘",
						"Use Tedix from your coding tools",
						"Claude Code, Codex and others see your team's tasks and results.",
					),
					point(
						"↻",
						"Let Tedix run tasks on this Mac",
						"Tasks assigned to this Mac start in the coding tool you choose.",
					),
					point(
						"✓",
						"Stay in control",
						"Every step shows what it changes. Nothing is switched on without you.",
					),
				),
			],
			primary: continueButton,
		};

	if (id === "sign-in") {
		const ran = steps["sign-in"];
		const waiting = Boolean(ran?.working);
		return {
			title: "Sign in on this Mac",
			lead: "This connects the Mac itself, so your coding tools and tasks work as you. It is separate from the sign-in inside the Tedix window.",
			content: [
				el(
					"div",
					"card",
					el("span", "badge", setup.signedIn ? "✓" : "→"),
					el(
						"div",
						"",
						el(
							"div",
							"name",
							setup.signedIn ? "This Mac is signed in" : "Not signed in yet",
						),
						el(
							"div",
							`state ${setup.signedIn ? "ok" : ""}`,
							setup.signedIn
								? `Account ${setup.who || "unknown"}${setup.organization ? ` · ${setup.organization}` : ""}`
								: cli.kind === "missing"
									? "Needs the command-line tool first."
									: "Your browser opens. Approve there and this window continues by itself.",
						),
					),
					el(
						"div",
						"actions",
						waiting
							? button("Cancel", "quiet", () => act("cancel", "sign-in"))
							: setup.signedIn &&
									button("Sign in again", "quiet", () => act("sign-in")),
					),
					el(
						"div",
						"below",
						...progress(
							waiting ? { ...ran, working: "Waiting for your browser…" } : ran,
							() => act("sign-in"),
						),
					),
				),
			],
			primary: setup.signedIn
				? continueButton
				: {
						label: waiting ? "Waiting for your browser…" : "Connect this Mac",
						click: () => act("sign-in"),
						disabled: waiting || cli.kind === "missing",
					},
			skip: !setup.signedIn,
		};
	}

	if (id === "cli") {
		const ran = steps.cli;
		const busy = Boolean(ran?.working);
		const line =
			cli.kind === "included"
				? `Included with the app · version ${cli.version}`
				: cli.kind === "separate"
					? `Installed separately · version ${cli.version || "unknown"}`
					: cli.kind === "own"
						? `Installed on this Mac · version ${cli.version}`
						: (cli.problem ??
							"Not found. Install the Tedix app from its download.");
		return {
			title: "Command-line tool",
			lead: "Your coding tools talk to Tedix through a small command called tedix. It comes with this app, and the app keeps it up to date.",
			content: [
				el(
					"div",
					"card",
					el("span", "badge", cli.kind === "missing" ? "!" : "✓"),
					el(
						"div",
						"",
						el("div", "name", "tedix"),
						el("div", `state ${cli.kind === "missing" ? "" : "ok"}`, line),
					),
					el(
						"div",
						"actions",
						cli.kind === "separate" &&
							button(
								"Let the app manage it",
								"plain",
								() => act("manage-cli"),
								busy,
							),
						cli.kind === "included" &&
							cli.canRestore &&
							button(
								"Use the separate install again",
								"quiet",
								() => act("restore-cli"),
								busy,
							),
					),
					el(
						"div",
						"below",
						cli.kind === "separate" &&
							!ran?.working &&
							!ran?.error &&
							el(
								"div",
								"note",
								"The app can use its own copy instead. Your install is kept and can be put back. This restarts the background service, which stops tasks that are running, and macOS may ask again to allow access to your folders.",
							),
						...serviceVersion(now).map((line) => el("div", "note", line)),
						...progress(ran, () =>
							act(cli.kind === "separate" ? "manage-cli" : "restore-cli"),
						),
					),
				),
			],
			primary: continueButton,
		};
	}

	if (id === "tools")
		return {
			title: "Your coding tools",
			lead: "Add Tedix to the tools you use, so they see your team's tasks and keep results in Tedix.",
			content: [
				...setup.tools.map((tool) => toolCard(tool, steps)),
				el(
					"div",
					"row",
					el("span", "note", "Installed a tool just now?"),
					button("Check again", "quiet", () => act("check")),
				),
			],
			primary: continueButton,
		};

	if (id === "chat")
		return {
			title: "Chat apps",
			lead: "These two are connected inside the app itself. Tedix cannot do it for you.",
			content: [
				el(
					"div",
					"card",
					el("span", "badge", "C"),
					el(
						"div",
						"",
						el("div", "name", "Claude"),
						el("div", "state", "Chat and Cowork"),
					),
					el(
						"div",
						"actions",
						button(
							"Copy address",
							"plain",
							() => void tedixShell.copy(CONNECTOR_URL),
						),
						button(
							"Open settings",
							"quiet",
							() => void tedixShell.open("claude-connectors"),
						),
					),
					el(
						"div",
						"below",
						el(
							"div",
							"note",
							"In Settings → Connectors, add a custom connector named Tedix with the address ",
							el("code", "", CONNECTOR_URL),
							". Then sign in.",
						),
					),
				),
				el(
					"div",
					"card",
					el("span", "badge", "G"),
					el(
						"div",
						"",
						el("div", "name", "ChatGPT desktop app"),
						el("div", "state", "Plugins Directory → turn on tedix"),
					),
					el("div", "actions"),
					el(
						"div",
						"below",
						el(
							"div",
							"note",
							"Add Tedix to Codex in the step before first. The ChatGPT app then lists it.",
						),
					),
				),
			],
			primary: continueButton,
		};

	if (id === "tasks") {
		const rows: Child[] = [];
		for (const runner of status.runners)
			rows.push(
				switchRow(
					`Start ${EXECUTOR_NAMES[runner.executor] ?? runner.executor} runs`,
					[
						runner.organization,
						runner.enabled
							? runner.running
								? "running"
								: "starting or stopped"
							: "off",
						runner.enabled && runner.problem,
					]
						.filter(Boolean)
						.join(" · "),
					runner.enabled,
					(on) => void tedixShell.set(runner.index, "enabled", on),
				),
			);
		for (const tool of setup.tools) {
			if (tool.found !== "found") continue;
			if (status.runners.some((runner) => runner.executor === tool.executor))
				continue;
			const ran = steps[`run:${tool.executor}`];
			rows.push(
				switchRow(
					`Start ${tool.name} runs`,
					setup.signedIn ? "Off" : "Sign in on this Mac first",
					Boolean(ran?.working),
					(on) => on && act("run-tasks", tool.id),
					Boolean(ran?.working) || !setup.signedIn,
				),
				...progress(ran, () => act("run-tasks", tool.id)),
			);
		}
		if (!rows.length)
			rows.push(
				el(
					"p",
					"note",
					"No coding tool was found on this Mac, so there is nothing to switch on yet.",
				),
			);
		rows.push(
			el(
				"div",
				"row",
				el(
					"span",
					"note",
					setup.repo
						? `Project folder: ${setup.repo}`
						: "New switches ask for the project folder Tedix should work in.",
				),
				button("Choose folder…", "plain", () => act("choose-folder")),
			),
		);
		const serving = status.servingIndex;
		if (serving !== undefined)
			rows.push(
				switchRow(
					"Let tedis edit files and run commands on this Mac",
					"A tedi is a Tedix agent. Off: it can only look. On: it can change files and run commands here.",
					status.machineWrite,
					(on) =>
						void tedixShell.set(
							serving,
							"machineWriteMode",
							on ? "allow" : "off",
						),
				),
			);
		if (now.openAtLogin !== undefined)
			rows.push(
				switchRow(
					"Open Tedix at login",
					"Tasks keep running without the app; this only opens the window.",
					now.openAtLogin,
					(on) => void tedixShell.openAtLogin(on),
				),
			);
		rows.push(
			el(
				"p",
				"note",
				"Changing a switch restarts the background service. Tasks that are running stop.",
			),
		);
		return {
			title: "Run tasks on this Mac",
			lead: "Choose which coding tools Tedix may start when a task is assigned to this Mac. Leave them off to only use Tedix yourself.",
			content: rows,
			primary: continueButton,
		};
	}

	// Ready.
	const item = (ok: boolean, text: string) =>
		el("li", "", el("span", ok ? "yes" : "no", ok ? "✓" : "–"), text);
	const running = status.runners.filter((runner) => runner.enabled);
	const ready = !setup.open;
	return {
		title: ready ? "This Mac is ready" : "Not finished yet",
		lead: ready
			? "Here is what is set up. You can change any of it later from the Tedix menu."
			: "Some steps are still open. You can finish them now or later from the Tedix menu.",
		content: [
			el(
				"ul",
				"summary",
				item(
					setup.signedIn,
					setup.signedIn
						? `Signed in as ${setup.who || "your account"}`
						: "Not signed in on this Mac",
				),
				item(
					cli.kind !== "missing",
					cli.kind === "missing"
						? "Command-line tool missing"
						: `Command-line tool ${cli.version}`,
				),
				...setup.tools.map((tool) =>
					item(
						tool.tedix === "added",
						`${tool.name}: ${
							tool.tedix === "added"
								? "Tedix is added"
								: tool.found === "absent"
									? "not found on this Mac"
									: tool.found === "no-command"
										? "command not found"
										: tool.tedix === "missing"
											? "found, Tedix not added"
											: tool.tedix === "checking"
												? "checking…"
												: "found"
						}`,
					),
				),
				item(
					running.length > 0,
					running.length
						? `Runs tasks with ${running.map((runner) => EXECUTOR_NAMES[runner.executor] ?? runner.executor).join(", ")}`
						: "Does not run tasks on this Mac",
				),
				item(
					setup.reach === "ok",
					setup.reach === "ok"
						? "Checked just now: this Mac reaches Tedix with your sign-in"
						: setup.reach === "checking"
							? "Checking that this Mac reaches Tedix…"
							: setup.reach === "unchecked"
								? "Connection to Tedix not checked"
								: `This Mac did not reach Tedix: ${setup.reach}`,
				),
			),
			el(
				"div",
				"row",
				el("span", "note", ""),
				button("Check again", "quiet", () => act("check")),
			),
		],
		primary: {
			label: "Open Tedix",
			click: () => void tedixShell.action("close-setup"),
		},
	};
}

function draw(): void {
	const now = state;
	if (!now) return;
	current ??= firstOpen(now);
	const id = current;
	const view = screenFor(id, now);
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
	const scroll = screen.querySelector(".content")?.scrollTop ?? 0;

	rail.replaceChildren(
		el(
			"div",
			"brand",
			Object.assign(el("img"), { src: "assets/icon.png", alt: "" }),
			"Tedix",
		),
		...STEPS.map(([step, name]) => {
			const done = step !== id && isDone(step, now);
			const node = el(
				"button",
				"",
				el("span", `dot ${done ? "done" : ""}`, done ? "✓" : ""),
				name,
			);
			node.type = "button";
			node.dataset.key = `rail:${step}`;
			if (step === id) node.setAttribute("aria-current", "step");
			node.setAttribute("aria-label", `${name}${done ? ", done" : ""}`);
			node.onclick = () => go(step);
			return node;
		}),
	);

	const primary = button(
		view.primary.label,
		"primary",
		view.primary.click,
		view.primary.disabled,
	);
	primary.id = "primary";
	primary.append(el("kbd", "", "↵"));
	const content = el(
		"div",
		`content ${drawn === id ? "" : "enter"}`,
		...view.content,
	);
	screen.replaceChildren(
		el(
			"header",
			drawn === id ? "" : "enter",
			el("h1", "", view.title),
			el("p", "lead", view.lead),
		),
		content,
		el(
			"footer",
			"",
			id !== "welcome" && button("Back", "quiet", back),
			view.skip && button("Skip for now", "quiet", next),
			el("span", "space"),
			primary,
		),
	);
	content.scrollTop = scroll;
	const again =
		drawn === id && focused
			? [...document.querySelectorAll<HTMLElement>("[data-key]")].find(
					(node) => node.dataset.key === focused,
				)
			: undefined;
	(again ?? (drawn === id ? undefined : primary))?.focus();
	drawn = id;
}

document.addEventListener("keydown", (event) => {
	const target = event.target as HTMLElement;
	if (event.key === "Escape") back();
	// Return on another button presses that button; anywhere else it continues.
	else if (event.key === "Enter" && target.tagName !== "BUTTON") {
		event.preventDefault();
		document.getElementById("primary")?.click();
	}
});

const receive = (incoming: PanelState) => {
	state = incoming;
	draw();
};
tedixShell.onState(receive);
void tedixShell.state().then(receive);
