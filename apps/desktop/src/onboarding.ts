import { cliUpdateLine, type PanelApi, type PanelState } from "./api";
import { icon, type IconName } from "./icons";
import type { StepRun, ToolRow } from "./setup";

/**
 * The Set up this Mac window: five screens drawn from the state the app
 * sends. Two shapes only: a centred mark with a headline (Welcome, Ready),
 * and a headline on the left with a plain list of rows on the right.
 */
declare const tedixShell: PanelApi;
const screen = document.getElementById("screen")!;
const foot = document.getElementById("foot")!;

const CONNECTOR_URL = "https://connect.mcp.tedix.dev/mcp";
const EXECUTOR_NAMES: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	opencode: "OpenCode",
	"any-local": "Any coding tool",
};
const TOOL_ICONS: Record<string, IconName> = {
	claude: "prompt",
	codex: "brackets",
	devin: "cube",
	opencode: "braces",
};
const STEPS = [
	["welcome", "Welcome"],
	["mac", "This Mac"],
	["tools", "Coding tools"],
	["tasks", "Run tasks"],
	["ready", "Ready"],
] as const;
type StepId = (typeof STEPS)[number][0];
const position = (id: StepId) => STEPS.findIndex(([step]) => step === id);

let state: PanelState | undefined;
let current: StepId | undefined;
let drawn: StepId | undefined;
/** Rows whose details are showing. */
const openDetails = new Set<string>();

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

function button(
	label: string,
	kind: "primary" | "plain" | "quiet" | "link",
	click: () => void,
	disabled = false,
): HTMLButtonElement {
	const node = el(
		"button",
		kind === "link" ? "link" : `btn ${kind === "plain" ? "" : kind}`,
		label,
	);
	node.type = "button";
	node.disabled = disabled;
	node.dataset.key = label;
	node.onclick = click;
	return node;
}

const act = (action: Parameters<PanelApi["setup"]>[0], id?: string) =>
	void tedixShell.setup(action, id);

const done = (label: string) => el("span", "done", icon("check", 13), label);

function toggle(
	title: string,
	checked: boolean,
	change: (on: boolean) => void,
	disabled = false,
): HTMLElement {
	const box = el("input");
	box.type = "checkbox";
	box.setAttribute("role", "switch");
	box.setAttribute("aria-label", title);
	box.checked = checked;
	box.disabled = disabled;
	box.dataset.key = `switch:${title}`;
	box.onchange = () => change(box.checked);
	return el("label", "switch", box);
}

interface RowView {
	key: string;
	icon: IconName;
	title: string;
	/** One short line: what is true now. */
	sub: string;
	/** The one control on the right. */
	control?: Child;
	ran?: StepRun;
	retry?: () => void;
	cancel?: () => void;
	/** Shown instead of the last output line while the step waits on the browser. */
	waiting?: string;
	/** Something failed that no step of this window ran. */
	failed?: string;
	/** Versions, places and reasons, behind "Details". */
	details?: Child[];
}

function row(view: RowView): HTMLElement {
	const { ran, key } = view;
	const working = ran?.working;
	const error = ran?.error ?? view.failed;
	const details = [...(view.details ?? [])].filter(Boolean);
	if (ran?.error && ran.details) details.push(ran.details);
	if (!working && !ran?.error && ran?.done) details.unshift(ran.done);
	const address = working ? ran?.address : undefined;
	if (address)
		details.push(
			"Browser did not open? Open the address yourself.",
			button("Copy address", "link", () => void tedixShell.copy(address)),
		);
	const open = openDetails.has(key) && details.length > 0;
	const more =
		details.length > 0 &&
		button(open ? "Hide details" : "Details", "link", () => {
			if (!openDetails.delete(key)) openDetails.add(key);
			draw();
		});
	if (more) more.dataset.key = `details:${key}`;
	return el(
		"div",
		"r",
		el("span", "glyph", icon(view.icon, 22)),
		el(
			"div",
			"text",
			el("div", "title", view.title),
			el(
				"div",
				"sub",
				el("span", "", working ? (view.waiting ?? working) : view.sub),
				more,
			),
		),
		el(
			"div",
			"control",
			working
				? view.cancel
					? button("Cancel", "quiet", view.cancel)
					: el("span", "spinner")
				: !ran?.error && view.control,
		),
		error &&
			el(
				"div",
				"fail",
				el("span", "", error),
				view.retry && button("Retry", "link", view.retry),
			),
		open &&
			el(
				"div",
				"details",
				...details.map((part) =>
					typeof part === "string" ? el("p", "", part) : part,
				),
			),
	);
}

const orgName = (id: string) => id.replace(/^org_/, "");
const person = ({ name, email }: { name: string; email: string }) =>
	name || email || "your account";

/** Tedix is in the tool and nothing about it needs the person. */
const connected = (tool: ToolRow) =>
	tool.found === "found" &&
	tool.tedix === "added" &&
	tool.enabled &&
	tool.connection !== "signed-out";

function toolRow(tool: ToolRow, steps: Record<string, StepRun>): HTMLElement {
	const adding = steps[`add:${tool.id}`];
	const connecting = steps[`connect:${tool.id}`];
	const ran =
		adding?.working || adding?.error ? adding : (connecting ?? adding);
	const base = {
		key: `tool:${tool.id}`,
		icon: TOOL_ICONS[tool.id] ?? ("terminal" as const),
		title: tool.name,
		ran,
		retry: () => act(ran === connecting ? "connect" : "add", tool.id),
		waiting:
			ran === connecting && ran?.working
				? "Waiting for your browser…"
				: undefined,
		cancel:
			ran === connecting
				? () => act("cancel", `connect:${tool.id}`)
				: undefined,
		details: [tool.note],
	};
	const signIn =
		tool.canSignIn && button("Sign in", "plain", () => act("connect", tool.id));
	if (tool.found === "no-command")
		return row({ ...base, sub: "Command not found" });
	if (tool.tedix === "checking")
		return row({
			...base,
			sub: "Checking…",
			control: el("span", "spinner"),
		});
	if (tool.tedix === "missing")
		return row({
			...base,
			sub: "Tedix not added yet",
			control: tool.canAdd && button("Add", "plain", () => act("add", tool.id)),
		});
	if (tool.tedix === "unsupported")
		return row({ ...base, sub: "Tedix cannot be added here yet" });
	if (tool.tedix === "unknown")
		return row({
			...base,
			sub: "Could not check right now",
			control: button("Check again", "quiet", () => act("check")),
		});
	if (!tool.enabled) return row({ ...base, sub: "Switched off in the tool" });
	if (tool.connection === "signed-out")
		return row({
			...base,
			sub: signIn ? "Not signed in yet" : "Sign in inside the tool",
			control: signIn,
		});
	if (tool.connection === "signed-in" || !signIn)
		return row({ ...base, sub: "Tedix added", control: done("Ready") });
	// Added, and the tool does not say whether it is signed in.
	return row({ ...base, sub: "Tedix added", control: signIn });
}

/** The one thing that still needs the person, and the screen that has it. */
function attention({
	setup,
}: PanelState): { text: string; step: StepId } | undefined {
	const failed = (prefix: string) =>
		Object.entries(setup.steps).some(
			([key, ran]) => key.startsWith(prefix) && ran.error,
		);
	if (setup.cli.kind === "missing")
		return { text: "The command-line tool was not found.", step: "mac" };
	if (setup.app.state === "out")
		return { text: "Tedix in this app is not signed in.", step: "mac" };
	if (!setup.signedIn || setup.reach === "signed-out")
		return {
			text: "This Mac's command-line tool is not signed in.",
			step: "mac",
		};
	if (failed("sign-in") || failed("cli"))
		return { text: "A step on This Mac did not finish.", step: "mac" };
	const tool = setup.tools.find(
		(row) =>
			row.found === "no-command" ||
			(row.tedix === "added" && !connected(row)) ||
			setup.steps[`add:${row.id}`]?.error ||
			setup.steps[`connect:${row.id}`]?.error,
	);
	if (tool) return { text: `${tool.name} needs attention.`, step: "tools" };
	if (failed("run:"))
		return { text: "A tool could not be switched on.", step: "tasks" };
	return undefined;
}

/** Nothing is left that needs the person, and the live check passed. */
const allSet = (now: PanelState) => !attention(now) && now.setup.reach === "ok";

/** Where the window starts: the tour, or the screen that needs something. */
function firstOpen(now: PanelState): StepId {
	const { setup } = now;
	if (setup.cli.kind === "missing" && setup.cli.problem) return "mac";
	if (!setup.signedIn) return "welcome";
	return attention(now)?.step ?? "ready";
}

interface Screen {
	/** Centred: a mark, an optional pill, a headline and up to two lines. */
	centre?: { mark: Child; pill?: Child; lines: Child[] };
	/** Split: the pill and one sentence on the left, rows on the right. */
	label?: string;
	sentence?: Child;
	rows?: Child[];
	headline: string;
	/** The bottom-right button; Return presses it. */
	primary: { label: string; click: () => void; disabled?: boolean };
	/** A quiet button beside it that moves on without doing the step. */
	later?: boolean;
}

function go(id: StepId): void {
	current = id;
	draw();
}
const next = () => {
	const at = current ? position(current) : 0;
	if (at < STEPS.length - 1) go(STEPS[at + 1]![0]);
};
const back = () => {
	const at = current ? position(current) : 0;
	if (at > 0) go(STEPS[at - 1]![0]);
};

const appIcon = () =>
	Object.assign(el("img"), { src: "assets/icon.png", alt: "" });

function screenFor(id: StepId, now: PanelState): Screen {
	const { setup, status } = now;
	const steps = setup.steps;
	const cli = setup.cli;
	const continueButton = { label: "Continue", click: next };

	if (id === "welcome") {
		const who = setup.app.state === "in" && person(setup.app);
		return {
			centre: {
				mark: appIcon(),
				lines: [
					el("p", "", "Connect your coding tools to Tedix."),
					who &&
						el(
							"span",
							"who",
							el("span", "avatar", who.slice(0, 1).toUpperCase()),
							who,
						),
				],
			},
			headline: "Set up this Mac",
			primary: { label: "Get started", click: next },
		};
	}

	if (id === "mac") {
		const ran = steps["sign-in"];
		const app = setup.app;
		const signInApp = () => act("app-sign-in");
		const signInCli = () => act("sign-in");
		const cliNeeded =
			cli.kind !== "missing" &&
			(!setup.signedIn || setup.reach === "signed-out");
		const signedIn = app.state === "in" && !cliNeeded && setup.signedIn;
		// One row for both sign-ins: this app first, then the command-line tool.
		const signIn: RowView =
			app.state === "out"
				? {
						key: "sign-in",
						icon: "person",
						title: "Sign in",
						sub: app.waiting
							? "Waiting for your browser…"
							: "Tedix in this app",
						control: button(
							app.waiting ? "Open browser again" : "Sign in",
							app.waiting ? "quiet" : "plain",
							signInApp,
						),
					}
				: cliNeeded
					? {
							key: "sign-in",
							icon: "person",
							title: "Sign in",
							sub: "Next: this Mac's command-line tool",
							control: button("Sign in", "plain", signInCli),
							ran: ran?.working || ran?.error ? ran : undefined,
							retry: signInCli,
							cancel: () => act("cancel", "sign-in"),
							waiting: "Waiting for your browser…",
						}
					: {
							key: "sign-in",
							icon: "person",
							title: signedIn ? "Signed in" : "Sign in",
							sub: signedIn
								? person(app)
								: cli.kind === "missing"
									? "Needs the command-line tool first"
									: "Could not check right now",
							control: signedIn
								? done("Done")
								: app.state === "unknown" &&
									button("Check again", "quiet", () => act("check")),
							details: signedIn
								? [
										app.email && app.email !== person(app) && app.email,
										setup.organization &&
											`Organization ${orgName(setup.organization)}.`,
										"This app and this Mac's command-line tool are both signed in.",
									]
								: [],
						};
		const running = [
			...new Set(
				status.runners
					.filter((runner) => runner.enabled && runner.version)
					.map((runner) => runner.version!),
			),
		];
		const tool: RowView = {
			key: "cli",
			icon: "terminal",
			title: "Command-line tool",
			sub: cli.updating
				? cli.updating
				: cli.kind === "missing"
					? "Not found"
					: `Version ${cli.version || "unknown"}`,
			control: cli.updating
				? el("span", "spinner")
				: cli.kind === "separate"
					? button("Let the app manage it", "plain", () => act("manage-cli"))
					: cli.kind === "included"
						? done("Included")
						: cli.kind === "own" && done("Installed"),
			ran: steps.cli,
			retry: () => act(cli.kind === "separate" ? "manage-cli" : "restore-cli"),
			failed:
				cli.kind === "missing"
					? (cli.problem ?? "Install the Tedix app again, then open it.")
					: cli.update?.ok === false && !cli.updating
						? cli.update.text
						: undefined,
			details: [
				cli.kind === "separate" &&
					"Installed separately. The app can use its own copy instead; yours is kept. That restarts the background service, which stops tasks that are running.",
				cli.update?.ok !== false && cliUpdateLine(cli),
				cli.other && `Version ${cli.other} is kept.`,
				running.some((version) => version !== cli.version) &&
					`The background service still runs version ${running.join(", ")}. Restart runners in Tedix → This Mac… to use this one.`,
				cli.access,
				cli.access &&
					button(
						"Open System Settings",
						"link",
						() => void tedixShell.open("folder-access"),
					),
				cli.kind === "included" &&
					cli.canRestore &&
					button("Use the separate install", "link", () => act("restore-cli")),
			],
		};
		const needs =
			app.state === "out" ? signInApp : cliNeeded ? signInCli : undefined;
		const waiting =
			Boolean(ran?.working) || (app.state === "out" && app.waiting);
		return {
			label: "This Mac",
			headline: "Sign in on this Mac",
			sentence: "Once for this app, once for the command-line tool.",
			rows: [
				row(signIn),
				row(tool),
				now.openAtLogin !== undefined &&
					row({
						key: "login",
						icon: "window",
						title: "Open at login",
						sub: "Opens the Tedix window",
						control: toggle(
							"Open at login",
							now.openAtLogin,
							(on) => void tedixShell.openAtLogin(on),
						),
					}),
			],
			primary: needs
				? {
						label: waiting ? "Waiting…" : "Sign in",
						click: needs,
						disabled: waiting,
					}
				: continueButton,
			later: Boolean(needs),
		};
	}

	if (id === "tools") {
		// Only tools Tedix can be added to; the others show under Run tasks.
		const found = setup.tools.filter(
			(tool) => tool.found !== "absent" && tool.tedix !== "unsupported",
		);
		return {
			label: "Coding tools",
			headline: "Add Tedix to your tools",
			sentence: el(
				"span",
				"",
				"Each tool signs in to Tedix by itself. ",
				button("Check again", "link", () => act("check")),
			),
			rows: [
				...found.map((tool) => toolRow(tool, steps)),
				found.length === 0 &&
					el("p", "none", "No coding tool was found on this Mac."),
				row({
					key: "chat:claude",
					icon: "bubble",
					title: "Claude app",
					sub: "Add a connector named Tedix",
					control: button(
						"Copy address",
						"quiet",
						() => void tedixShell.copy(CONNECTOR_URL),
					),
					details: [
						"In Settings → Connectors, add a custom connector named Tedix with the copied address, then sign in.",
						button(
							"Open settings",
							"link",
							() => void tedixShell.open("claude-connectors"),
						),
					],
				}),
				row({
					key: "chat:chatgpt",
					icon: "bubble-spark",
					title: "ChatGPT app",
					sub: "Plugins Directory → turn on tedix",
					details: ["Add Tedix to Codex first. The ChatGPT app then lists it."],
				}),
			],
			primary: continueButton,
		};
	}

	if (id === "tasks") {
		const rows: Child[] = [];
		for (const runner of status.runners) {
			const name = EXECUTOR_NAMES[runner.executor] ?? runner.executor;
			rows.push(
				row({
					key: `runner:${runner.index}`,
					icon:
						TOOL_ICONS[
							setup.tools.find((tool) => tool.executor === runner.executor)
								?.id ?? ""
						] ?? "bolt",
					title: name,
					sub: runner.enabled
						? runner.running
							? "Running"
							: "Starting or stopped"
						: "Off",
					control: toggle(
						`Start ${name} tasks`,
						runner.enabled,
						(on) => void tedixShell.set(runner.index, "enabled", on),
					),
					details: [
						`For ${orgName(runner.organization)}.`,
						runner.enabled && runner.problem,
					],
				}),
			);
		}
		for (const tool of setup.tools) {
			// Ready: Tedix is in the tool, or the tool needs nothing added.
			if (!connected(tool) && tool.tedix !== "unsupported") continue;
			if (tool.found !== "found") continue;
			if (status.runners.some((runner) => runner.executor === tool.executor))
				continue;
			const ran = steps[`run:${tool.executor}`];
			rows.push(
				row({
					key: `run:${tool.id}`,
					icon: TOOL_ICONS[tool.id] ?? "bolt",
					title: tool.name,
					sub: setup.signedIn ? "Off" : "Sign in on this Mac first",
					control: toggle(
						`Start ${tool.name} tasks`,
						false,
						(on) => on && act("run-tasks", tool.id),
						!setup.signedIn,
					),
					ran,
					retry: () => act("run-tasks", tool.id),
				}),
			);
		}
		const serving = status.servingIndex;
		return {
			label: "Run tasks",
			headline: "Let Tedix start tasks",
			sentence: "Tasks that are running stop when a switch changes.",
			rows: [
				...rows,
				rows.length === 0 &&
					el("p", "none", "No coding tool was found on this Mac."),
				serving !== undefined &&
					row({
						key: "write",
						icon: "shield",
						title: "Let Tedix edit files and run commands",
						sub: status.machineWrite ? "On" : "Off: it can only look",
						control: toggle(
							"Let Tedix edit files and run commands",
							status.machineWrite,
							(on) =>
								void tedixShell.set(
									serving,
									"machineWriteMode",
									on ? "allow" : "off",
								),
						),
					}),
				row({
					key: "folder",
					icon: "folder",
					title: "Project folder",
					sub: setup.repo
						? setup.repo.split("/").at(-1) || setup.repo
						: "Asked when you switch a tool on",
					control: button("Choose…", "quiet", () => act("choose-folder")),
					details: [setup.repo],
				}),
			],
			primary: continueButton,
		};
	}

	// Ready.
	const openTedix = {
		label: "Open Tedix",
		click: () => void tedixShell.action("close-setup"),
	};
	const needs = attention(now);
	if (needs)
		return {
			centre: {
				mark: appIcon(),
				lines: [
					el(
						"p",
						"",
						`${needs.text} `,
						button("Fix", "link", () => go(needs.step)),
					),
				],
			},
			headline: "Almost ready",
			primary: openTedix,
		};
	if (setup.reach !== "ok")
		return {
			centre: {
				mark: appIcon(),
				lines: [
					setup.reach === "unavailable"
						? el(
								"p",
								"",
								"Tedix could not be reached just now. ",
								button("Check again", "link", () => act("check")),
							)
						: el("p", "", "Checking that this Mac reaches Tedix…"),
				],
			},
			headline: "Almost ready",
			primary: openTedix,
		};
	const tools = setup.tools.filter(connected).length;
	const runs = status.runners
		.filter((runner) => runner.enabled)
		.map((runner) => EXECUTOR_NAMES[runner.executor] ?? runner.executor);
	const mark = el("span", "check", icon("check", 56));
	return {
		centre: {
			mark,
			lines: [
				el(
					"p",
					"",
					[
						`${tools} ${tools === 1 ? "tool" : "tools"} connected`,
						runs.length ? `runs ${runs.join(", ")} tasks` : "runs no tasks",
					].join(" · "),
				),
			],
		},
		headline: "This Mac is ready",
		primary: openTedix,
	};
}

/** The footer is built once, so the progress dashes can change width smoothly. */
const backButton = el("button", "back", icon("back", 16));
backButton.type = "button";
backButton.setAttribute("aria-label", "Back");
backButton.onclick = back;
const dashes = STEPS.map(([step, name]) => {
	const dash = el("button", "dash");
	dash.type = "button";
	dash.setAttribute("aria-label", name);
	dash.onclick = () => go(step);
	return dash;
});
const actions = el("div", "actions");
foot.append(
	backButton,
	el("div", "dashes", ...dashes),
	el("span", "space"),
	actions,
);

function draw(): void {
	const now = state;
	if (!now) return;
	current ??= firstOpen(now);
	const id = current;
	const view = screenFor(id, now);
	const same = drawn === id;
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
	const scroll = screen.querySelector(".rows")?.scrollTop ?? 0;

	const headline = el("h1", "", view.headline);
	const body = view.centre
		? el(
				"div",
				"centre",
				el("div", "mark", view.centre.mark),
				view.centre.pill,
				headline,
				...view.centre.lines,
			)
		: el(
				"div",
				"split",
				el(
					"div",
					"side",
					el("span", "pill", view.label),
					headline,
					el("p", "", view.sentence),
				),
				el("div", "rows", ...(view.rows ?? [])),
			);
	// A new screen fades and slides in: the left column first, then each row.
	if (!same) {
		const parts = view.centre
			? [...body.children]
			: [body.firstElementChild!, ...body.lastElementChild!.children];
		parts.forEach((part, index) => {
			part.classList.add("in");
			(part as HTMLElement).style.setProperty(
				"--i",
				String(Math.min(index, 6)),
			);
		});
	}
	screen.replaceChildren(body);
	const rows = screen.querySelector(".rows");
	if (rows) rows.scrollTop = scroll;

	const at = position(id);
	backButton.hidden = at === 0;
	dashes.forEach((dash, index) => {
		if (index === at) dash.setAttribute("aria-current", "step");
		else dash.removeAttribute("aria-current");
	});
	const primary = button(
		view.primary.label,
		"primary",
		view.primary.click,
		view.primary.disabled,
	);
	primary.id = "primary";
	primary.append(el("kbd", "", "↵"));
	actions.replaceChildren(
		...[view.later && button("Later", "quiet", next), primary].filter(
			(node): node is HTMLButtonElement => !!node,
		),
	);

	const again =
		same && focused
			? [...document.querySelectorAll<HTMLElement>("[data-key]")].find(
					(node) => node.dataset.key === focused,
				)
			: undefined;
	(again ?? (same ? undefined : primary))?.focus();
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
