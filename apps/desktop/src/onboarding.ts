import { cliUpdateLine, type PanelApi, type PanelState } from "./api";
import { icon, type IconName } from "./icons";
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
const TOOL_ICONS: Record<string, IconName> = {
	claude: "prompt",
	codex: "brackets",
	devin: "cube",
	opencode: "braces",
};
const STEPS = [
	["welcome", "Welcome", "sparkle"],
	["sign-in", "Sign in", "person"],
	["cli", "Command-line tool", "terminal"],
	["tools", "Coding tools", "plug"],
	["chat", "Chat apps", "bubble"],
	["tasks", "Run tasks", "bolt"],
	["ready", "Ready", "flag"],
] as const;
type StepId = (typeof STEPS)[number][0];
const position = (id: StepId) => STEPS.findIndex(([step]) => step === id);

let state: PanelState | undefined;
let current: StepId | undefined;
let drawn: StepId | undefined;
/** Screens with nothing to tick off count as done once seen. */
const seen = new Set<StepId>();
/** What was done at the last draw, so a check animates only when it appears. */
let doneBefore: Set<string> | undefined;
let doneNow = new Set<string>();
/** The draw in progress shows the same screen as the one before. */
let sameScreen = false;

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

/** A check that draws itself the first time `key` is seen done. */
function check(key: string, size = 16): SVGSVGElement {
	const mark = icon("check", size);
	doneNow.add(key);
	if (
		doneBefore &&
		!doneBefore.has(key) &&
		(sameScreen || key.startsWith("rail:"))
	)
		mark.classList.add("pop");
	return mark;
}

type Tone = "good" | "warn" | "bad" | "";

interface CardView {
	key: string;
	icon: IconName;
	name: string;
	/** The one line that says what is true now. */
	state: string;
	tone?: Tone;
	checking?: boolean;
	absent?: boolean;
	/** The one button for what this needs next. */
	action?: HTMLElement | false;
	note?: Child;
	ran?: StepRun;
	retry?: () => void;
	/** Stops the step while it works. */
	cancel?: () => void;
	/** Shown instead of the last output line while the step waits on the browser. */
	waiting?: string;
}

function card(view: CardView): HTMLElement {
	const { ran } = view;
	const extra: Child[] = [];
	if (ran?.working) {
		const address = ran.address;
		extra.push(
			el(
				"div",
				"live",
				el("span", "spinner"),
				el("span", "", view.waiting ?? ran.working),
			),
			address &&
				el(
					"div",
					"row",
					el(
						"span",
						"note grow",
						"Browser did not open? Copy the address and open it yourself.",
					),
					button("Copy address", "plain", () => void tedixShell.copy(address)),
				),
		);
	} else if (ran?.error) {
		const details = ran.details ?? ran.error;
		extra.push(
			el(
				"div",
				"problem",
				el("p", "", ran.error),
				el(
					"div",
					"row",
					view.retry && button("Retry", "plain", view.retry),
					button("Copy details", "quiet", () => void tedixShell.copy(details)),
				),
			),
		);
	} else {
		if (ran?.done) extra.push(el("div", "note", ran.done));
		if (view.note) extra.push(el("div", "note", view.note));
	}
	const tone = view.tone ?? "";
	return el(
		"div",
		`card ${view.absent ? "absent" : ""}`,
		el(
			"div",
			"card-main",
			el(
				"span",
				`tile ${tone === "good" ? "good" : tone ? "warn" : ""}`,
				icon(view.icon, 20),
			),
			el(
				"div",
				"",
				el("div", "name", view.name),
				el(
					"div",
					`state ${tone}`,
					view.checking
						? el("span", "spinner")
						: tone === "good"
							? check(view.key, 14)
							: el("span", "mark"),
					view.state,
				),
			),
			el(
				"div",
				"row",
				ran?.working
					? view.cancel && button("Cancel", "quiet", view.cancel)
					: !ran?.error && view.action,
			),
		),
		extra.some(Boolean) && el("div", "card-extra", ...extra),
	);
}

/** One tool: the line that is true now and the one thing it needs next. */
function toolCard(tool: ToolRow, steps: Record<string, StepRun>): HTMLElement {
	const adding = steps[`add:${tool.id}`];
	const connecting = steps[`connect:${tool.id}`];
	const ran =
		adding?.working || adding?.error ? adding : (connecting ?? adding);
	const retry = () => act(ran === connecting ? "connect" : "add", tool.id);
	const base = {
		key: `tool:${tool.id}`,
		icon: TOOL_ICONS[tool.id] ?? "terminal",
		name: tool.name,
		ran,
		retry,
		waiting:
			ran === connecting && ran?.working
				? "Waiting for your browser. Approve there and this continues by itself."
				: undefined,
		cancel:
			ran === connecting
				? () => act("cancel", `connect:${tool.id}`)
				: undefined,
	};
	if (tool.found === "absent")
		return card({ ...base, state: "Not on this Mac", absent: true });
	if (tool.found === "no-command")
		return card({
			...base,
			state: "Command not found",
			tone: "warn",
			note: tool.note,
		});
	if (tool.tedix === "checking")
		return card({ ...base, state: "Checking…", checking: true });
	const version = tool.version ? ` · version ${tool.version}` : "";
	if (tool.tedix === "missing")
		return card({
			...base,
			state: "Tedix not added yet",
			action:
				tool.canAdd && button("Add Tedix", "plain", () => act("add", tool.id)),
		});
	if (tool.tedix === "unsupported")
		return card({
			...base,
			state: "Found · Tedix cannot be added here yet",
			note: tool.note,
		});
	if (tool.tedix === "unknown")
		return card({
			...base,
			state: "Could not check right now",
			action: button("Check again", "plain", () => act("check")),
			note: tool.note,
		});
	if (!tool.enabled)
		return card({
			...base,
			state: `Tedix added${version} · switched off`,
			tone: "warn",
			note: tool.note,
		});
	if (tool.connection === "signed-in")
		return card({
			...base,
			state: `Tedix added${version} · signed in`,
			tone: "good",
		});
	const signIn =
		tool.canSignIn && button("Sign in", "plain", () => act("connect", tool.id));
	if (tool.connection === "signed-out")
		return card({
			...base,
			state: `Tedix added${version} · not signed in yet`,
			tone: "warn",
			action: signIn,
			note: tool.note,
		});
	// Added, and the tool does not say whether it is signed in.
	return card({
		...base,
		state: `Tedix added${version}`,
		tone: "good",
		action: signIn,
		note: tool.note,
	});
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
		el("span", "", el("span", "title", title), el("small", "", detail)),
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
		running.some((version) => version !== setup.cli.version) &&
			`The background service still runs version ${running.join(", ")}. Choose Restart runners in Tedix → This Mac… to use the one above; that stops tasks that are running.`,
	].filter((line): line is string => Boolean(line));
}

const orgName = (id: string) => id.replace(/^org_/, "");
const person = ({ name, email }: { name: string; email: string }) =>
	name && email && name !== email
		? `${name} · ${email}`
		: name || email || "your account";

/** One line of the summary: what it is, how it stands, and where to fix it. */
interface Item {
	what: string;
	detail: string;
	status: "done" | "skipped" | "attention" | "checking";
	/** Says it better than "Skipped" when nothing was skipped. */
	pill?: string;
	/** The step where it can be changed; none when nothing can be done here. */
	step?: StepId;
}

function toolItem(tool: ToolRow, steps: Record<string, StepRun>): Item {
	const failed = steps[`add:${tool.id}`]?.error;
	const base = { what: tool.name, step: "tools" as const };
	const version = tool.version ? ` ${tool.version}` : "";
	if (failed) return { ...base, detail: failed, status: "attention" };
	if (tool.tedix === "checking")
		return { ...base, detail: "Checking…", status: "checking" };
	if (tool.found === "no-command")
		return { ...base, detail: "Command not found", status: "attention" };
	if (tool.tedix === "missing")
		return { ...base, detail: "Tedix not added", status: "skipped" };
	if (tool.tedix === "unknown" || tool.tedix === "unsupported")
		return {
			what: tool.name,
			detail:
				tool.tedix === "unsupported"
					? "Tedix cannot be added here yet"
					: "Could not check right now",
			status: "skipped",
		};
	if (!tool.enabled)
		return {
			...base,
			detail: `Tedix${version} added, switched off`,
			status: "attention",
		};
	if (tool.connection === "signed-out")
		return {
			...base,
			detail: `Tedix${version} added, not signed in yet`,
			status: "attention",
		};
	return {
		...base,
		detail: `Tedix${version} added${tool.connection === "signed-in" ? ", signed in" : ""}`,
		status: "done",
	};
}

function summaryItems({ setup, status }: PanelState): Item[] {
	const cli = setup.cli;
	const running = status.runners.filter((runner) => runner.enabled);
	const reach: Item =
		setup.reach === "ok"
			? {
					what: "Connection",
					detail: "Checked just now: this Mac reaches Tedix with its sign-in",
					status: "done",
					step: "ready",
				}
			: setup.reach === "signed-out"
				? {
						what: "Connection",
						detail: "Tedix asks the command-line tool to sign in again",
						status: "attention",
						step: "sign-in",
					}
				: setup.reach === "unavailable"
					? {
							what: "Connection",
							detail: "Could not check right now",
							status: "skipped",
							pill: "Not checked",
							step: "ready",
						}
					: {
							what: "Connection",
							detail: setup.signedIn
								? "Checking that this Mac reaches Tedix…"
								: "Checked after the command-line tool is signed in",
							status: setup.signedIn ? "checking" : "skipped",
							step: "ready",
						};
	return [
		{
			what: "Tedix in this app",
			detail:
				setup.app.state === "in"
					? `Signed in as ${person(setup.app)}`
					: setup.app.state === "out"
						? "Not signed in yet"
						: "Could not check right now",
			status:
				setup.app.state === "in"
					? "done"
					: setup.app.state === "out"
						? "attention"
						: "skipped",
			step: "sign-in",
		},
		{
			what: "Command-line tool",
			detail:
				cli.kind === "missing"
					? (cli.problem ?? "Not found")
					: `Version ${cli.version || "unknown"}${setup.signedIn ? ", signed in" : ", not signed in yet"}`,
			status: cli.kind === "missing" || !setup.signedIn ? "attention" : "done",
			step: cli.kind === "missing" ? "cli" : "sign-in",
		},
		...setup.tools
			.filter((tool) => tool.found !== "absent")
			.map((tool) => toolItem(tool, setup.steps)),
		{
			what: "Tasks on this Mac",
			detail: running.length
				? `Starts ${running.map((runner) => EXECUTOR_NAMES[runner.executor] ?? runner.executor).join(", ")} runs`
				: "Off: Tedix does not start runs here",
			status: running.length ? "done" : "skipped",
			step: "tasks",
		},
		reach,
	];
}

const PILL = {
	done: "Done",
	skipped: "Skipped",
	attention: "Needs attention",
	checking: "Checking",
} as const;

function summaryTable(now: PanelState, jump: boolean): HTMLElement {
	const rows = summaryItems(now).map((item) => {
		const open = item.status !== "done" && item.status !== "checking";
		const step = item.step;
		return el(
			"tr",
			"",
			el("td", "what", item.what),
			el("td", "detail", item.detail),
			el(
				"td",
				"end",
				jump &&
					open &&
					(item.what === "Connection"
						? button("Check again", "link", () => act("check"))
						: step &&
							button(item.status === "skipped" ? "Set up" : "Fix", "link", () =>
								go(step),
							)),
				el(
					"span",
					`pill ${item.status}`,
					item.status === "done"
						? check(`summary:${item.what}`, 13)
						: item.status === "checking"
							? el("span", "spinner")
							: icon(item.status === "attention" ? "warning" : "minus", 13),
					item.pill ?? PILL[item.status],
				),
			),
		);
	});
	return el("div", "card", el("table", "summary", el("tbody", "", ...rows)));
}

type StepStatus = "done" | "attention" | "open";

function stepStatus(id: StepId, now: PanelState): StepStatus {
	const { setup, status } = now;
	const failed = (prefix: string) =>
		Object.entries(setup.steps).some(
			([key, ran]) => key.startsWith(prefix) && ran.error,
		);
	if (id === "sign-in") {
		if (failed("sign-in") || setup.reach === "signed-out") return "attention";
		return setup.signedIn && setup.app.state !== "out" ? "done" : "open";
	}
	if (id === "cli") {
		if (failed("cli") || setup.cli.problem) return "attention";
		return setup.cli.kind === "missing" ? "open" : "done";
	}
	if (id === "tools") {
		const items = setup.tools
			.filter((tool) => tool.found !== "absent")
			.map((tool) => toolItem(tool, setup.steps));
		if (failed("connect:") || items.some((item) => item.status === "attention"))
			return "attention";
		return items.some((item) => item.status === "done") &&
			items.every((item) => item.detail !== "Tedix not added")
			? "done"
			: "open";
	}
	if (id === "tasks") {
		if (failed("run:")) return "attention";
		return status.runners.some((runner) => runner.enabled) ? "done" : "open";
	}
	if (id === "ready") return allSet(now) ? "done" : "open";
	return seen.has(id) ? "done" : "open";
}

/** Nothing is left that needs the person. */
function allSet(now: PanelState): boolean {
	return (
		!now.setup.open &&
		summaryItems(now).every(
			(item) => item.status === "done" || item.status === "skipped",
		) &&
		now.setup.reach === "ok"
	);
}

/** Where the window starts: the tour, or the first step that needs something. */
function firstOpen(now: PanelState): StepId {
	const { setup } = now;
	if (setup.cli.kind === "missing" && setup.cli.problem) return "cli";
	if (!setup.signedIn || allSet(now)) return "welcome";
	return (
		(["sign-in", "cli", "tools"] as const).find(
			(id) => stepStatus(id, now) === "attention",
		) ?? "ready"
	);
}

interface Screen {
	title: string;
	lead: string;
	content: Child[];
	/** The bottom-right button; Return presses it. */
	primary: { label: string; click: () => void; disabled?: boolean };
	/** A second button beside it. */
	second?: HTMLElement;
	skip?: boolean;
	/** The welcome screen has its own heading. */
	bare?: boolean;
}

let backwards = false;
function go(id: StepId): void {
	if (current) seen.add(current);
	backwards = current !== undefined && position(id) < position(current);
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

function point(glyph: IconName, title: string, detail: string): HTMLElement {
	return el(
		"li",
		"",
		el("span", "tile", icon(glyph, 20)),
		el("div", "", el("b", "", title), el("small", "", detail)),
	);
}

const appIcon = () =>
	Object.assign(el("img"), { src: "assets/icon.png", alt: "" });

function screenFor(id: StepId, now: PanelState): Screen {
	const { setup, status } = now;
	const steps = setup.steps;
	const cli = setup.cli;
	const continueButton = { label: "Continue", click: next };

	if (id === "welcome") {
		if (allSet(now))
			return {
				bare: true,
				title: "",
				lead: "",
				content: [
					el(
						"div",
						"hero compact",
						appIcon(),
						el("h1", "", "This Mac is ready"),
						el(
							"p",
							"",
							"Everything below is set up. Change any of it from the steps on the left.",
						),
						el(
							"span",
							"chip good",
							check("welcome:ready", 13),
							"Checked just now",
						),
					),
					summaryTable(now, false),
				],
				primary: {
					label: "Open Tedix",
					click: () => void tedixShell.action("close-setup"),
				},
				second: button("Review the steps", "plain", next),
			};
		return {
			bare: true,
			title: "",
			lead: "",
			content: [
				el(
					"div",
					"hero",
					appIcon(),
					el("h1", "", "Set up this Mac for Tedix"),
					el(
						"p",
						"",
						"Your coding tools and your team's tasks in one place, with you in control.",
					),
					el("span", "chip", icon("clock", 13), "About 2 minutes"),
				),
				el(
					"ul",
					"points",
					point(
						"plug",
						"Use Tedix from your coding tools",
						"Claude Code, Codex and others see your team's tasks and results.",
					),
					point(
						"bolt",
						"Let Tedix run tasks on this Mac",
						"Tasks assigned to this Mac start in the coding tool you choose.",
					),
					point(
						"shield",
						"Stay in control",
						"Every step shows what it changes. Nothing is switched on without you.",
					),
				),
			],
			primary: { label: "Get started", click: next },
		};
	}

	if (id === "sign-in") {
		const ran = steps["sign-in"];
		const waiting = Boolean(ran?.working);
		const app = setup.app;
		const signInApp = () => act("app-sign-in");
		const signInCli = () => act("sign-in");
		const organization = setup.organization
			? ` · organization ${orgName(setup.organization)}`
			: "";
		return {
			title: "Sign in",
			lead: "There are two sign-ins. One is for the Tedix window in this app. The other is for this Mac's command-line tool, which your coding tools and tasks use.",
			content: [
				card({
					key: "sign-in:app",
					icon: "window",
					name: "Tedix in this app",
					state:
						app.state === "in"
							? `Signed in as ${person(app)}`
							: app.waiting
								? "Waiting for your browser…"
								: app.state === "out"
									? "Not signed in yet"
									: "Could not check right now",
					tone: app.state === "in" ? "good" : app.state === "out" ? "warn" : "",
					checking: app.waiting,
					action:
						app.state === "out"
							? button(
									app.waiting ? "Open the browser again" : "Sign in",
									"plain",
									signInApp,
								)
							: app.state === "unknown" &&
								button("Check again", "plain", () => act("check")),
					note:
						app.waiting &&
						"Sign in there, then choose Open the Tedix app. This window notices by itself.",
				}),
				card({
					key: "sign-in:cli",
					icon: "terminal",
					name: "This Mac's command-line tool",
					state: setup.signedIn
						? `Signed in${organization}`
						: cli.kind === "missing"
							? "Needs the command-line tool first"
							: "Not signed in yet",
					tone: setup.signedIn ? "good" : "warn",
					action:
						(!setup.signedIn || setup.reach === "signed-out") &&
						cli.kind !== "missing" &&
						button("Sign in", "plain", signInCli),
					cancel: () => act("cancel", "sign-in"),
					note:
						setup.reach === "signed-out" &&
						"Tedix asks for a new sign-in. Choose Sign in to do it again.",
					ran: ran?.working || ran?.error ? ran : undefined,
					retry: signInCli,
					waiting:
						"Waiting for your browser. Approve there and this continues by itself.",
				}),
			],
			primary:
				!setup.signedIn && cli.kind !== "missing"
					? {
							label: waiting
								? "Waiting for your browser…"
								: "Sign in on this Mac",
							click: signInCli,
							disabled: waiting,
						}
					: app.state === "out" && !app.waiting
						? { label: "Sign in to Tedix", click: signInApp }
						: continueButton,
			skip: !setup.signedIn || app.state === "out",
		};
	}

	if (id === "cli") {
		const ran = steps.cli;
		const line =
			cli.kind === "included"
				? `Comes with this app · version ${cli.version}`
				: cli.kind === "separate"
					? `Installed separately · version ${cli.version || "unknown"}`
					: cli.kind === "own"
						? `Installed on this Mac · version ${cli.version}`
						: "Not found";
		// Versions and state only: the update button in the main window is the
		// one place that replaces the command-line tool.
		const failed = cli.update?.ok === false && !cli.updating;
		const updateLine = [
			cliUpdateLine(cli) ||
				"The app looks for a newer version when it starts and every four hours. When there is one, an Update available button appears at the top right of the Tedix window. Nothing is replaced until you click it.",
			cli.other && `Version ${cli.other} is kept.`,
		]
			.filter(Boolean)
			.join(" ");
		const updates =
			cli.kind !== "missing" &&
			cli.kind !== "own" &&
			el(
				"div",
				failed ? "problem" : "row",
				cli.updating && el("span", "spinner"),
				el(failed ? "p" : "div", "", updateLine),
			);
		const access =
			cli.access &&
			el(
				"div",
				"problem soft",
				el("p", "", cli.access),
				button(
					"Open System Settings",
					"plain",
					() => void tedixShell.open("folder-access"),
				),
			);
		const about =
			cli.kind === "missing"
				? (cli.problem ??
					"Install the Tedix app from its download, then open it again.")
				: cli.kind === "separate"
					? "The app can use its own copy instead. Your install is kept and can be put back. This restarts the background service, which stops tasks that are running, and macOS may ask again to allow access to your folders."
					: serviceVersion(now).join(" ");
		const note = el("div", "", about && el("div", "", about), updates, access);
		note.style.display = "grid";
		note.style.gap = "8px";
		return {
			title: "Command-line tool",
			lead: "Your coding tools talk to Tedix through a small command called tedix. It comes with this app, and the app offers you newer versions between app updates.",
			content: [
				card({
					key: "cli",
					icon: "terminal",
					name: "tedix",
					state: line,
					tone: cli.kind === "missing" ? "warn" : "good",
					action:
						cli.kind === "separate"
							? button("Let the app manage it", "plain", () =>
									act("manage-cli"),
								)
							: cli.kind === "included" &&
								cli.canRestore &&
								button("Use the separate install", "quiet", () =>
									act("restore-cli"),
								),
					note,
					ran,
					retry: () =>
						act(cli.kind === "separate" ? "manage-cli" : "restore-cli"),
				}),
			],
			primary: continueButton,
		};
	}

	if (id === "tools")
		return {
			title: "Your coding tools",
			lead: "Add Tedix to the tools you use, so they see your team's tasks and keep results in Tedix. Each tool signs in to Tedix by itself.",
			content: [
				...setup.tools.map((tool) => toolCard(tool, steps)),
				el(
					"div",
					"row",
					el("span", "note grow", "Installed a tool or signed in just now?"),
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
				card({
					key: "chat:claude",
					icon: "bubble",
					name: "Claude",
					state: "Chat and Cowork",
					action: el(
						"div",
						"row",
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
					note: el(
						"span",
						"",
						"In Settings → Connectors, add a custom connector named Tedix with the address ",
						el("code", "", CONNECTOR_URL),
						". Then sign in.",
					),
				}),
				card({
					key: "chat:chatgpt",
					icon: "bubble-spark",
					name: "ChatGPT desktop app",
					state: "Plugins Directory → turn on tedix",
					note: "Add Tedix to Codex in the step before first. The ChatGPT app then lists it.",
				}),
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
						orgName(runner.organization),
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
					ran?.working
						? ran.working
						: setup.signedIn
							? "Off"
							: "Sign in this Mac's command-line tool first",
					Boolean(ran?.working),
					(on) => on && act("run-tasks", tool.id),
					Boolean(ran?.working) || !setup.signedIn,
				),
				ran?.error &&
					el(
						"div",
						"inset",
						el(
							"div",
							"problem",
							el("p", "", ran.error),
							el(
								"div",
								"row",
								button("Retry", "plain", () => act("run-tasks", tool.id)),
								button(
									"Copy details",
									"quiet",
									() => void tedixShell.copy(ran.details ?? ran.error ?? ""),
								),
							),
						),
					),
				ran?.done && el("div", "inset note", ran.done),
			);
		}
		const options: Child[] = [];
		const serving = status.servingIndex;
		if (serving !== undefined)
			options.push(
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
			options.push(
				switchRow(
					"Open Tedix at login",
					"Tasks keep running without the app; this only opens the window.",
					now.openAtLogin,
					(on) => void tedixShell.openAtLogin(on),
				),
			);
		return {
			title: "Run tasks on this Mac",
			lead: "Choose which coding tools Tedix may start when a task is assigned to this Mac. Leave them off to only use Tedix yourself.",
			content: [
				rows.length
					? el("div", "card", ...rows)
					: el(
							"p",
							"note",
							"No coding tool was found on this Mac, so there is nothing to switch on yet.",
						),
				el(
					"div",
					"card",
					el(
						"div",
						"card-main",
						el("span", "tile", icon("folder", 20)),
						el(
							"div",
							"",
							el("div", "name", "Project folder"),
							el(
								"div",
								"state",
								setup.repo || "New switches ask which folder Tedix works in",
							),
						),
						button("Choose…", "plain", () => act("choose-folder")),
					),
				),
				options.length > 0 && el("div", "card", ...options),
				el(
					"p",
					"note",
					"Changing a switch restarts the background service. Tasks that are running stop.",
				),
			],
			primary: continueButton,
		};
	}

	// Ready.
	const ready = allSet(now);
	const open = summaryItems(now).filter(
		(item) => item.status === "attention",
	).length;
	return {
		title: ready
			? "This Mac is ready"
			: open
				? `${open} ${open === 1 ? "thing needs" : "things need"} attention`
				: "Almost there",
		lead: ready
			? "Here is what is set up. You can change any of it later from Tedix → Set Up This Mac…"
			: "Here is where each step stands. Fix what you need now, or come back later from Tedix → Set Up This Mac…",
		content: [
			summaryTable(now, true),
			setup.reach === "unavailable" &&
				el(
					"div",
					"row",
					el(
						"span",
						"note grow",
						"Tedix was slow or busy just now. That says nothing about your sign-in.",
					),
					setup.reachDetail &&
						button(
							"Copy details",
							"quiet",
							() => void tedixShell.copy(setup.reachDetail),
						),
				),
		],
		primary: {
			label: "Open Tedix",
			click: () => void tedixShell.action("close-setup"),
		},
		second: button("Done", "plain", () => void tedixShell.action("done-setup")),
	};
}

function draw(): void {
	const now = state;
	if (!now) return;
	current ??= firstOpen(now);
	const id = current;
	doneNow = new Set();
	sameScreen = drawn === id;
	const view = screenFor(id, now);
	const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
	const scroll = screen.querySelector(".content")?.scrollTop ?? 0;
	const entering = drawn === id ? "" : `enter ${backwards ? "back" : ""}`;

	rail.replaceChildren(
		el("div", "brand", appIcon(), "Set up this Mac"),
		...STEPS.map(([step, name, glyph]) => {
			const status = step === id ? "open" : stepStatus(step, now);
			const node = el(
				"button",
				"",
				el("span", "glyph", icon(glyph, 17)),
				name,
				el(
					"span",
					`status ${status}`,
					status === "done" && check(`rail:${step}`, 15),
				),
			);
			node.type = "button";
			node.dataset.key = `rail:${step}`;
			if (step === id) node.setAttribute("aria-current", "step");
			node.setAttribute(
				"aria-label",
				`${name}${status === "done" ? ", done" : status === "attention" ? ", needs attention" : ""}`,
			);
			node.onclick = () => go(step);
			return node;
		}),
		el(
			"div",
			"foot",
			"You can stop at any point and come back from the Tedix menu.",
		),
	);

	const primary = button(
		view.primary.label,
		"primary",
		view.primary.click,
		view.primary.disabled,
	);
	primary.id = "primary";
	primary.append(el("kbd", "", "↵"));
	const content = el("div", `content ${entering}`, ...view.content);
	const at = position(id);
	const backButton = id !== "welcome" && button("Back", "quiet", back);
	if (backButton) backButton.append(el("kbd", "", "esc"));
	screen.replaceChildren(
		view.bare
			? el("header")
			: el(
					"header",
					entering,
					el("div", "eyebrow", `Step ${at} of ${STEPS.length - 1}`),
					el("h1", "", view.title),
					el("p", "lead", view.lead),
				),
		content,
		el(
			"footer",
			"",
			backButton,
			view.skip && button("Skip for now", "quiet", next),
			el("span", "space"),
			view.second,
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
	doneBefore = doneNow;
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
