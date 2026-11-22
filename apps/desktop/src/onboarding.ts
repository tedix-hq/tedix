import { cliUpdateLine, type PanelApi, type PanelState } from "./api";
import { icon, type IconName } from "./icons";
import type { StepRun } from "./setup";
import {
	CONNECTOR_URL,
	foundTools,
	keepFocus,
	READY_MARK,
	runnerFor,
	type SessionsUi,
	sessionsPanel,
	TOOL_ICONS,
	toolView,
	useForTasks,
} from "./ui-parts";

/**
 * The Set up this Mac window: the first-run screens, drawn from the state
 * the app sends. Every setting here is also in Settings. Two shapes only: a centred mark with a headline (Welcome, Ready),
 * and a headline on the left with a plain list of rows on the right.
 */
declare const tedixShell: PanelApi;
const screen = document.getElementById("screen")!;
const foot = document.getElementById("foot")!;

const STEPS = [
	["welcome", "Welcome"],
	["mac", "This Mac"],
	["tools", "Coding tools"],
	["sessions", "Sessions"],
	["ready", "Ready"],
] as const;
type StepId = (typeof STEPS)[number][0];
const position = (id: StepId) => STEPS.findIndex(([step]) => step === id);

let state: PanelState | undefined;
let current: StepId | undefined;
let drawn: StepId | undefined;
/** Rows whose details are showing. */
const openDetails = new Set<string>();
const sessionsUi: SessionsUi = { query: "" };

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

function toggleSwitch(
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

/**
 * A coding tool is on this Mac (or runs tasks here). Without one, setup is
 * only signing in to this app and adding Tedix to the Claude or ChatGPT
 * app: no command-line tool, no project folder, no sessions.
 */
const coding = (now: PanelState) =>
	foundTools(now).length > 0 || now.status.runners.length > 0;

/** The one thing that still needs the person, and the screen that has it. */
function attention(
	now: PanelState,
): { text: string; step: StepId } | undefined {
	const { setup } = now;
	if (!coding(now))
		return setup.app.state === "out"
			? { text: "Sign in to Tedix in this app.", step: "mac" }
			: undefined;
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
	if (failed("run:"))
		return { text: "A tool could not be switched on.", step: "tools" };
	return undefined;
}

/** Nothing is left that needs the person, and the live check passed. */
const allSet = (now: PanelState) => !attention(now) && now.setup.reach === "ok";

/** Where the window starts: the tour, or the screen that needs something. */
function firstOpen(now: PanelState): StepId {
	const { setup } = now;
	if (setup.cli.kind === "missing" && setup.cli.problem) return "mac";
	if (!setup.signedIn || setup.app.state !== "in") return "welcome";
	return attention(now)?.step ?? "ready";
}

/** One of the big choices on the first screen. */
interface Choice {
	title: string;
	sub: string;
	click: () => void;
}

interface Screen {
	/** Centred: a mark, an optional pill, a headline and up to two lines. */
	centre?: { mark: Child; pill?: Child; lines: Child[]; choices?: Choice[] };
	/** Split: the pill and one sentence on the left, rows on the right. */
	label?: string;
	sentence?: Child;
	rows?: Child[];
	headline: string;
	/** The bottom-right button; Return presses it. */
	/** Absent when the screen offers big choices instead. */
	primary?: { label: string; click: () => void; disabled?: boolean };
	/** A quiet button beside it that moves on without doing the step. */
	later?: boolean;
}

function go(id: StepId): void {
	current = id;
	draw();
}
/** The steps this Mac needs: Sessions only with a coding tool. */
const shown = (step: StepId) =>
	step !== "sessions" || (state !== undefined && coding(state));
const next = () => {
	let at = current ? position(current) : 0;
	do at++;
	while (at < STEPS.length && !shown(STEPS[at]![0]));
	if (at < STEPS.length) go(STEPS[at]![0]);
};
const back = () => {
	let at = current ? position(current) : 0;
	do at--;
	while (at > 0 && !shown(STEPS[at]![0]));
	if (at >= 0) go(STEPS[at]![0]);
};

/**
 * The Claude and ChatGPT apps, the ones on this Mac first. Adding Tedix is
 * one step in each app; nothing here does it for the person.
 */
function chatRows(now: PanelState): HTMLElement[] {
	const apps = now.setup.chatApps;
	const claude = row({
		key: "chat:claude",
		icon: "bubble",
		title: "Claude",
		sub: apps.claude
			? "Add Tedix in Claude under Connectors"
			: "Add Tedix under Connectors on claude.ai",
		control: el(
			"span",
			"controls",
			button(
				"Copy address",
				"plain",
				() => void tedixShell.copy(CONNECTOR_URL),
			),
			button(
				"Open Connectors",
				"quiet",
				() => void tedixShell.open("claude-connectors"),
			),
		),
	});
	const chatgpt = row({
		key: "chat:chatgpt",
		icon: "bubble-spark",
		title: "ChatGPT",
		sub: apps.chatgpt
			? "Turn on Tedix in ChatGPT under Plugins"
			: "Turn on Tedix under Plugins on chatgpt.com",
		control: button(
			"Open Plugins",
			"plain",
			() => void tedixShell.open("chatgpt"),
		),
	});
	return apps.chatgpt && !apps.claude ? [chatgpt, claude] : [claude, chatgpt];
}

const appIcon = () =>
	Object.assign(el("img"), { src: "assets/icon.png", alt: "" });

function screenFor(id: StepId, now: PanelState): Screen {
	const { setup, status } = now;
	const steps = setup.steps;
	const cli = setup.cli;
	const continueButton = { label: "Continue", click: next };

	if (id === "welcome") {
		const who = setup.app.state === "in" && person(setup.app);
		const choices: Choice[] = [
			{
				title: "Use Tedix Cloud",
				sub: "Sign in, or ask for access.",
				click: next,
			},
		];
		// A developer can try Tedix first: no account, nothing else changes.
		if (now.app.localWorkspace)
			choices.push({
				title: "Try it on this Mac",
				sub: "No account. A sample workspace that stays on this Mac.",
				click: () => void tedixShell.action("start-local-workspace"),
			});
		return {
			centre: {
				mark: appIcon(),
				lines: [
					el("p", "", "Use Tedix here and in the apps you already use."),
					who &&
						el(
							"span",
							"who",
							el("span", "avatar", who.slice(0, 1).toUpperCase()),
							who,
						),
				],
				choices: choices.length > 1 ? choices : undefined,
			},
			headline: "Set up this Mac",
			primary:
				choices.length > 1 ? undefined : { label: "Get started", click: next },
		};
	}

	if (id === "mac") {
		const ran = steps["sign-in"];
		const app = setup.app;
		const signInApp = () => act("app-sign-in");
		const signInCli = () => act("sign-in");
		const devTools = coding(now);
		// The command-line tool's sign-in matters only for coding tools.
		const cliNeeded =
			devTools &&
			cli.kind !== "missing" &&
			(!setup.signedIn || setup.reach === "signed-out");
		const signedIn =
			app.state === "in" && !cliNeeded && (setup.signedIn || !devTools);
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
					: `Version ${cli.version.split("+")[0] || "unknown"}`,
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
					"Installed separately. The app can use its own copy instead; yours is kept. That restarts this Mac's runners, which stops tasks that are running.",
				cli.update?.ok !== false && cliUpdateLine(cli),
				cli.other && `Version ${cli.other} is kept.`,
				running.some((version) => version !== cli.version) &&
					"Restart in Settings → This Mac to use this version.",
				cli.access,
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
			sentence: devTools
				? "Once for this app, once for the command-line tool."
				: "Sign in to Tedix in this app.",
			rows: [
				row(signIn),
				devTools && row(tool),
				now.openAtLogin !== undefined &&
					row({
						key: "login",
						icon: "window",
						title: "Open at login",
						sub: "Opens the Tedix window",
						control: toggleSwitch(
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
		const found = foundTools(now);
		const tools = found.map((tool) => {
			const view = toolView(now, tool);
			const on = Boolean(runnerFor(now, tool)?.enabled);
			return row({
				key: `tool:${tool.id}`,
				icon: TOOL_ICONS[tool.id] ?? "terminal",
				title: tool.name,
				sub: view.sub,
				control: el(
					"span",
					"controls",
					view.ready ? READY_MARK() : view.action,
					toggleSwitch(
						`Use ${tool.name} for tasks`,
						on,
						(next) => useForTasks(now, tool, next),
						!setup.signedIn,
					),
				),
				ran: view.working
					? { working: view.working }
					: view.error
						? { error: view.error }
						: undefined,
				retry: view.retry,
				cancel: view.cancel,
				waiting: view.working,
			});
		});
		if (!found.length)
			return {
				label: "Your apps",
				headline: "Use Tedix in Claude or ChatGPT",
				sentence:
					"Add Tedix once in each app you use. You can also use Tedix right here.",
				rows: chatRows(now),
				primary: continueButton,
			};
		// One click for people who want it all: add Tedix to each tool found
		// and switch it on for tasks. Each stays a switch they can turn off.
		const todo = found.filter(
			(tool) => !toolView(now, tool).ready && !runnerFor(now, tool)?.enabled,
		);
		const setUpAll = async () => {
			for (const tool of todo) {
				if (tool.tedix === "missing" && tool.canAdd)
					await tedixShell.setup("add", tool.id);
				useForTasks(now, tool, true);
			}
		};
		return {
			label: "Coding tools",
			headline: "Choose your tools",
			sentence: el(
				"span",
				"",
				"Switch on the tools Tedix may use for tasks, then sign in only those. ",
				button("Check again", "link", () => act("check")),
			),
			rows: [...chatRows(now), ...tools],
			primary: todo.length
				? {
						label: "Set everything up",
						click: () => void setUpAll().then(next),
						disabled: !setup.signedIn,
					}
				: continueButton,
			later: todo.length > 0,
		};
	}

	if (id === "sessions") {
		const pending = !setup.sessionsChosen;
		const projects = setup.sessionProjects.map((project) => project.id);
		return {
			label: "Sessions",
			headline: "Show your sessions in Tedix",
			sentence:
				"On for every project to start. You can change this later in Settings.",
			rows: [sessionsPanel(now, sessionsUi, () => keepFocus(draw), pending)],
			primary: {
				label: "Continue",
				click: () => {
					// The default is applied only when the person moves on.
					if (pending && projects.length && setup.signedIn)
						act("sessions-on", `*|${projects.join(",")}`);
					next();
				},
			},
			later: pending,
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
						button("Open setup step", "link", () => go(needs.step)),
					),
				],
			},
			headline: "Finish setting up this Mac",
			primary: openTedix,
		};
	if (!coding(now))
		return {
			centre: {
				mark: el("span", "check", icon("check", 56)),
				lines: [
					el(
						"p",
						"",
						"Ask Tedix here, or in Claude and ChatGPT once you added it there.",
					),
				],
			},
			headline: "You're all set",
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
	const enabled = status.runners.filter((runner) => runner.enabled);
	const running = enabled.filter((runner) => runner.running).length;
	// A tool switched on for tasks that still needs a step.
	const tool = foundTools(now).find(
		(row) =>
			runnerFor(now, row)?.enabled &&
			!toolView(now, row).ready &&
			!toolView(now, row).working,
	);
	const lines: Child[] = [];
	if (enabled.length === 0)
		lines.push(
			el(
				"p",
				"",
				"Turn on a tool to run tasks here. ",
				button("Choose tools", "link", () => go("tools")),
			),
		);
	else if (enabled.length > running)
		lines.push(
			el(
				"p",
				"",
				`${running} of ${enabled.length} tools are running. `,
				button("Check tools", "link", () => go("tools")),
			),
		);
	if (tool)
		lines.push(
			el(
				"p",
				"",
				`To use Tedix inside ${tool.name}, finish connecting it. `,
				button("Open coding tools", "link", () => go("tools")),
			),
		);
	return {
		centre: {
			mark: running > 0 ? el("span", "check", icon("check", 56)) : appIcon(),
			lines,
		},
		headline:
			running > 0
				? "This Mac can run tasks"
				: enabled.length
					? "Tasks are unavailable on this Mac"
					: "This Mac is connected",
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
				view.centre.choices &&
					el(
						"div",
						"choices",
						...view.centre.choices.map((choice, index) => {
							const node = el(
								"button",
								"choice",
								el("span", "title", choice.title),
								el("span", "sub", choice.sub),
							);
							node.type = "button";
							node.dataset.key = `choice:${index}`;
							node.onclick = choice.click;
							return node;
						}),
					),
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
		dash.hidden = !shown(STEPS[index]![0]);
		if (index === at) dash.setAttribute("aria-current", "step");
		else dash.removeAttribute("aria-current");
	});
	const primary =
		view.primary &&
		button(
			view.primary.label,
			"primary",
			view.primary.click,
			view.primary.disabled,
		);
	if (primary) {
		primary.id = "primary";
		primary.append(el("kbd", "", "↵"));
	}
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
