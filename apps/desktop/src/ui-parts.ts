import type { PanelApi, PanelState } from "./api";
import { icon, type IconName } from "./icons";
import type { SessionProject, StepRun, ToolRow } from "./setup";
import type { RunnerRow } from "./status";
import { agentConnectionProblem, tedixAccountSummary } from "./tool-connection";

/**
 * What Settings and the first-run setup share: small element
 * helpers, the coding tool rows and the Sessions list. Both pages are
 * plain DOM drawn from the state the app sends.
 */
declare const tedixShell: PanelApi;

export type Child = Node | string | false | undefined | null;
export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className = "",
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	node.append(...children.filter((child): child is Node | string => !!child));
	return node;
}

/** Buttons whose action still runs, by key: the words they show meanwhile. */
const running = new Map<string, string>();
/** Buttons that just finished, by key: a short result such as "Copied". */
const finished = new Map<string, string>();
let ranChanged = () => {};
/** The page redraws when a button starts or stops working. */
export function onButtonsChange(redraw: () => void): void {
	ranChanged = redraw;
}

export interface ButtonOptions {
	/** Shown with a spinner from the click until the action settles, e.g. "Checking…". */
	pending?: string;
	/** Shown for a moment after the action succeeds, e.g. "Copied". */
	done?: string;
	/** Tells apart buttons with the same words, such as each row's "Open". */
	key?: string;
}

/**
 * A button. When its action returns a promise and `pending` is given, it
 * shows a spinner and those words at once and stays disabled until the
 * action settles, across redraws; the row then shows the result.
 */
export function button(
	label: string,
	kind: "primary" | "plain" | "quiet" | "link",
	click: () => unknown,
	disabled = false,
	options: ButtonOptions = {},
): HTMLButtonElement {
	const key = options.key ?? label;
	const busy = running.get(key);
	const result = finished.get(key);
	const node = el(
		"button",
		kind === "link" ? "link" : `btn ${kind === "plain" ? "" : kind}`,
		busy !== undefined && el("span", "spinner"),
		busy ?? result ?? label,
	);
	node.type = "button";
	node.disabled = disabled || busy !== undefined;
	if (busy !== undefined) node.setAttribute("aria-busy", "true");
	node.dataset.key = key;
	node.onclick = () => {
		const outcome = click();
		if (!(outcome instanceof Promise)) return;
		if (options.pending) {
			running.set(key, options.pending);
			ranChanged();
		}
		void outcome.then(
			() => {
				running.delete(key);
				if (options.done) {
					finished.set(key, options.done);
					setTimeout(() => {
						finished.delete(key);
						ranChanged();
					}, 1500);
				}
				ranChanged();
			},
			() => {
				running.delete(key);
				ranChanged();
			},
		);
	};
	return node;
}

/** A switch with a spoken name; the row it sits in gives the visible title. */
export function toggle(
	label: string,
	checked: boolean,
	change: (on: boolean) => void,
	disabled = false,
): HTMLLabelElement {
	const box = el("input");
	box.type = "checkbox";
	box.setAttribute("role", "switch");
	box.setAttribute("aria-label", label);
	box.checked = checked;
	box.disabled = disabled;
	box.dataset.key = `switch:${label}`;
	box.onchange = () => change(box.checked);
	return el("label", "switch", box);
}

export const act = (action: Parameters<PanelApi["setup"]>[0], id?: string) =>
	tedixShell.setup(action, id);

const CHECKING = { pending: "Checking…", key: "check" };
/** Looks for coding tools and their state again. */
export const checkAgain = (label = "Check again") => {
	const node = button(label, "quiet", () => act("check"), false, CHECKING);
	node.classList.add("recheck");
	return node;
};

export const EXECUTOR_NAMES: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	opencode: "OpenCode",
	"any-local": "Any agent",
};
/** The Mac app each coding tool comes with, for its icon. */
export const TOOL_APPS: Record<
	string,
	"chatgpt" | "claude" | "devin" | "opencode"
> = {
	codex: "chatgpt",
	claude: "claude",
	devin: "devin",
	opencode: "opencode",
};

export const TOOL_ICONS: Record<string, IconName> = {
	claude: "prompt",
	codex: "brackets",
	devin: "cube",
	opencode: "braces",
};

export const agentToolName = (tool: Pick<ToolRow, "id" | "name">) =>
	tool.id === "codex"
		? "Codex"
		: tool.id === "claude"
			? "Claude Code"
			: tool.name;

export const namedAgentTool = (tool: ToolRow): ToolRow => {
	const name = agentToolName(tool);
	return name === tool.name ? tool : { ...tool, name };
};

/** The public plugin repository, which Claude accepts as a marketplace. */
export const CLAUDE_MARKETPLACE = "tedix-hq/tedix-plugins";

export const CLAUDE_PLUGIN_SUB =
	"Add Tedix to Claude as a plugin. Claude keeps it up to date.";

/**
 * The Cowork plugin setup as numbered steps, each with the button for it,
 * and the plugin file for organizations that turn marketplaces off.
 */
export function claudePluginSteps(): HTMLElement {
	const step = (text: string, control?: Child) =>
		el("li", "", el("span", "", text), control);
	return el(
		"div",
		"steps",
		el(
			"ol",
			"",
			step(
				"Copy the Tedix plugin address.",
				button(
					"Copy",
					"plain",
					() => tedixShell.copy(CLAUDE_MARKETPLACE),
					false,
					{ done: "Copied", key: "copy-marketplace" },
				),
			),
			step(
				"In Claude, choose Customize → Plugins → Add marketplace, paste the address and install Tedix.",
				button("Open Claude", "plain", () => tedixShell.open("claude-app")),
			),
			step("Open the plugin’s Connectors tab and sign in."),
		),
		el(
			"p",
			"",
			"Can’t add a marketplace? ",
			button("Save the plugin file", "link", () =>
				tedixShell.action("save-claude-plugin"),
			),
			" and choose Add → Upload plugin in Claude.",
		),
	);
}

export function openAgentApp(state: PanelState, tool: ToolRow) {
	const app = tool.id === "codex" ? "chatgpt" : tool.id;
	if (
		app !== "claude" &&
		app !== "chatgpt" &&
		app !== "devin" &&
		app !== "opencode"
	)
		return;
	if (!state.setup.desktopApps[app]) return;
	if (tool.found === "found" && !tool.desktop) return;
	return button(
		app === "chatgpt" &&
			tool.readVerified &&
			(tool.hookTrust === "untrusted" || tool.hookTrust === "unknown")
			? "Allow Tedix in ChatGPT"
			: `Open ${app === "chatgpt" ? "ChatGPT" : app === "claude" ? "Claude" : tool.name}`,
		"quiet",
		() => tedixShell.open(`${app}-app`),
	);
}

export const orgName = (id: string) => id.replace(/^org_/, "");
export const person = ({ name, email }: { name: string; email: string }) =>
	name || email || "your account";

/** The tool confirmed its connection to Tedix. */
export const connected = (tool: ToolRow) =>
	tool.found === "found" &&
	tool.tedix === "added" &&
	tool.enabled &&
	(tool.account === "signed-in" ||
		(tool.account === "unknown" &&
			(tool.id === "devin" || tool.id === "opencode"))) &&
	tool.connection === "signed-in" &&
	tool.readVerified;

/** The tools on this Mac that Tedix can work with; absent ones are hidden. */
export const foundTools = (state: PanelState) =>
	state.setup.tools.filter(
		(tool) => tool.found !== "absent" && tool.tedix !== "unsupported",
	);

export const runnerFor = (state: PanelState, tool: ToolRow) =>
	state.status.runners.find((runner) => runner.executor === tool.executor);

/** What one coding tool row says and offers now. */
export interface ToolView {
	sub: string;
	tone?: "good" | "warn" | "bad";
	/** The one next step, as a button. */
	action?: HTMLButtonElement;
	/** Connection verified, with a running runner when showing tasks. */
	ready: boolean;
	working?: string;
	error?: string;
	/** What the failed step printed, behind a "Details" link. */
	details?: string;
	retry?: () => void;
	cancel?: () => void;
}

export function toolView(
	state: PanelState,
	tool: ToolRow,
	view: "connection" | "tasks" = "tasks",
): ToolView {
	const steps = state.setup.steps;
	const runner = view === "tasks" ? runnerFor(state, tool) : undefined;
	const reviewInChatGPT =
		tool.id === "codex" &&
		tool.desktop &&
		(tool.hookTrust === "untrusted" || tool.hookTrust === "unknown");
	const keys = ["account", "connect", "verify"].map(
		(kind) => [kind, steps[`${kind}:${tool.id}`]] as const,
	);
	const running = view === "tasks" ? steps[`run:${tool.executor}`] : undefined;
	const busy =
		keys.find(([, ran]) => ran?.working) ??
		(running?.working ? (["run", running] as const) : undefined);
	if (busy) {
		const [kind, ran] = busy;
		const stoppable = kind !== "run";
		const browser =
			(kind === "account" || kind === "connect") &&
			(ran as StepRun).address?.startsWith("https://");
		return {
			sub: "",
			ready: false,
			working:
				kind === "account"
					? "Finish signing in in your browser…"
					: (ran as StepRun).working,
			action: browser
				? button("Open sign-in again", "plain", () =>
						act("open-sign-in", `${kind}:${tool.id}`),
					)
				: undefined,
			cancel: stoppable ? () => act("cancel", `${kind}:${tool.id}`) : undefined,
		};
	}
	const failed =
		keys.find(([, ran]) => ran?.error) ??
		(running?.error ? (["run", running] as const) : undefined);
	const again: Record<string, Parameters<typeof act>[0]> = {
		account: "account-sign-in",
		connect: "connect",
		verify: "verify",
		run: "run-tasks",
	};
	const base = failed
		? {
				error: (failed[1] as StepRun).error,
				details: (failed[1] as StepRun).details,
				retry: () =>
					act(
						failed[0] === "verify" && tool.connection === "signed-out"
							? "connect"
							: again[failed[0]]!,
						tool.id,
					),
			}
		: {};
	const plain = (
		label: string,
		action: Parameters<typeof act>[0],
		pending: string,
	) =>
		button(label, "plain", () => act(action, tool.id), false, {
			pending,
			key: `${tool.id}:${action}`,
		});

	if (tool.found === "no-command")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: tool.note,
			action: openAgentApp(state, tool),
		};
	if (tool.tedix === "checking")
		return { ...base, ready: false, sub: "Checking…" };
	if (tool.account === "signed-out") {
		// Connect carries the app's own sign-in first, then Tedix sign-in and
		// verification, so one click is enough unless the app is already
		// connected or this tool cannot sign in to Tedix from here.
		const linked =
			tool.tedix === "added" &&
			tool.enabled &&
			tool.connection === "signed-in" &&
			tool.readVerified;
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `Sign in to your ${tool.name} account first.`,
			action: tool.canSignInAccount
				? tool.canSignIn && !linked
					? plain("Connect", "account-sign-in", "Connecting…")
					: plain(`Sign in to ${tool.name}`, "account-sign-in", "Signing in…")
				: undefined,
		};
	}
	if (tool.tedix === "missing")
		return {
			...base,
			ready: false,
			sub: tool.canSignIn
				? tool.id === "codex" || tool.id === "claude"
					? "Install the Tedix plugin with hooks."
					: ""
				: tool.note,
			action:
				tool.canAdd && tool.canSignIn
					? plain("Connect", "connect", "Connecting…")
					: undefined,
		};
	if (tool.tedix === "unknown")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `Tedix couldn’t check ${tool.name}.`,
			action: checkAgain("Try again"),
		};
	if (!tool.enabled)
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `Tedix is turned off in ${tool.name}`,
			action: checkAgain(),
		};
	const problem = agentConnectionProblem({
		connection: tool.connection,
		duplicate: tool.duplicateConnection,
		grant: tool.grant,
		grantUnavailable: tool.grantUnavailable,
		mismatch: tedixAccountSummary(
			tool.tedixAccount,
			state.setup.app.state === "in" ? state.setup.app.email : "",
		).mismatch,
		now: Date.now(),
	});
	if (problem)
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: problem.text,
			action:
				problem.action === "remove"
					? button("Remove", "plain", () =>
							tedixShell.open("claude-connectors"),
						)
					: problem.action === "check"
						? checkAgain()
						: tool.canSignIn
							? plain(
									problem.action === "account"
										? "Sign in as you"
										: "Sign in again",
									"connect",
									"Signing in…",
								)
							: openAgentApp(state, tool),
		};
	const needsConnection =
		tool.connection === "signed-out" ||
		(tool.connection === "unknown" &&
			(tool.id === "claude" || tool.id === "codex"));
	if (needsConnection && tool.canSignIn)
		return {
			...base,
			ready: false,
			sub: "",
			action: plain("Connect", "connect", "Connecting…"),
		};
	if (!connected(tool))
		return {
			...base,
			ready: false,
			sub:
				tool.connection === "signed-out"
					? tool.note
					: "Check that Tedix works in this app.",
			action:
				tool.connection !== "signed-out"
					? plain("Check connection", "verify", "Checking…")
					: undefined,
		};
	// A plugin without hooks has nothing to allow: offer the app's own copy.
	if (
		tool.id === "codex" &&
		tool.desktop &&
		tool.hookTrust === "none" &&
		tool.publishedPlugin
	)
		return {
			...base,
			ready: view === "connection",
			tone: view === "tasks" && runner?.enabled ? "warn" : undefined,
			sub: "Tedix in ChatGPT has no hooks, so it cannot add your team's instructions or task context to your chats. Choose Add hooks to use the Tedix plugin from this app instead; you stay signed in.",
			action: plain("Add hooks", "replace-plugin", "Adding hooks…"),
		};
	if (view === "connection")
		return {
			ready: true,
			sub: reviewInChatGPT
				? "In ChatGPT, open Settings → Hooks and allow Tedix. This lets Tedix add your team's instructions when a chat starts and add related task context to your messages, and, if Show my sessions in Tedix is on, save a summary of each session."
				: "",
		};
	if (
		runner?.enabled &&
		tool.id === "codex" &&
		(tool.hookTrust === "untrusted" || tool.hookTrust === "unknown")
	)
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: reviewInChatGPT
				? "In ChatGPT, open Settings → Hooks and allow Tedix. This lets Tedix add your team's instructions when a chat starts and add related task context to your messages, and, if Show my sessions in Tedix is on, save a summary of each session."
				: "Before ChatGPT runs tasks, open ChatGPT and allow the Tedix hooks in Settings → Hooks. They let Tedix add your team's instructions and task context to the chat.",
			action: reviewInChatGPT
				? openAgentApp(state, tool)
				: state.setup.desktopApps.chatgpt
					? button("Open ChatGPT", "quiet", () =>
							tedixShell.open("chatgpt-app"),
						)
					: undefined,
		};
	if (!runner?.enabled) return { ...base, ready: false, sub: "Connected" };
	if (!runner.running)
		return {
			...base,
			ready: false,
			tone: runner.problem ? "warn" : undefined,
			sub: state.app.paused
				? "Paused"
				: runner.problem
					? "Not running"
					: "Starting…",
		};
	return { ...base, ready: true, sub: "Running tasks" };
}

/** Switches a tool's tasks on or off; only that tool's runner changes. */
export function useForTasks(
	state: PanelState,
	tool: ToolRow,
	on: boolean,
): void {
	const runner = runnerFor(state, tool);
	if (runner) void tedixShell.set(runner.index, "enabled", on);
	else if (on) act("run-tasks", tool.id);
}

/** Runner entries for no known tool, such as one for any coding tool. */
export const otherRunners = (state: PanelState): RunnerRow[] =>
	state.status.runners.filter(
		(runner) =>
			!state.setup.tools.some((tool) => tool.executor === runner.executor),
	);

export const READY_MARK = (label = "Ready") =>
	el("span", "done", icon("check", 13), label);

/* ------------------------------------------------------------------ */
/* Sessions: one main switch, a tab per coding tool, a searchable list. */

export interface SessionsUi {
	tab?: string;
	query: string;
}

const DAY = 24 * 60 * 60_000;
function ago(iso: string): string {
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return "";
	const days = Math.floor((Date.now() - at) / DAY);
	if (days < 1) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 30) return `${days} days ago`;
	const months = Math.round(days / 30);
	return months < 12
		? `${months} month${months === 1 ? "" : "s"} ago`
		: `${Math.round(months / 12)} year${months < 18 ? "" : "s"} ago`;
}

/** The coding tools on this Mac whose sessions can show, by executor id. */
export const sessionTools = (state: PanelState) =>
	state.setup.tools
		.filter((tool) => tool.found !== "absent")
		.map((tool) => tool.executor);

/**
 * `pending`: nothing was ever chosen; the switch shows the default (on for
 * every project) and the caller applies it when the person moves on.
 */
export function sessionsPanel(
	state: PanelState,
	ui: SessionsUi,
	redraw: () => void,
	pending: boolean,
): HTMLElement {
	const { setup } = state;
	const tools = sessionTools(state);
	const projects = setup.sessionProjects;
	const ran = Object.entries(setup.steps).find(([key]) =>
		key.startsWith("sessions"),
	)?.[1];
	if (!setup.signedIn)
		return el("p", "empty", "Sign in on this Mac to choose projects.");
	if (!tools.length) return el("p", "empty", "No agent was found on this Mac.");
	if (!projects.length)
		return el(
			"div",
			"empty",
			ran?.working
				? el("span", "live", el("span", "spinner"), "Reading projects…")
				: ran?.error
					? el(
							"span",
							"fail",
							ran.error,
							" ",
							button("Retry", "link", () => act("check"), false, CHECKING),
						)
					: "No projects yet.",
		);
	const all = projects.map((project) => project.id);
	const anyOn = projects.some((project) =>
		tools.some((tool) => project.on[tool]),
	);
	const main = el(
		"div",
		"group",
		el(
			"div",
			"item",
			el("div", "text", el("div", "title", "Show my sessions in Tedix")),
			el(
				"div",
				"control",
				ran?.working && el("span", "spinner"),
				toggle(
					"Show my sessions in Tedix",
					pending || anyOn,
					(on) =>
						act(on ? "sessions-on" : "sessions-off", `*|${all.join(",")}`),
					Boolean(ran?.working),
				),
			),
		),
	);
	const tab = ui.tab && tools.includes(ui.tab) ? ui.tab : tools[0]!;
	const tabs = el(
		"div",
		"segmented",
		...tools.map((tool) => {
			const node = button(EXECUTOR_NAMES[tool] ?? tool, "plain", () => {
				ui.tab = tool;
				redraw();
			});
			node.className = "seg";
			node.setAttribute("role", "tab");
			node.setAttribute("aria-selected", String(tool === tab));
			node.dataset.key = `tab:${tool}`;
			return node;
		}),
	);
	tabs.setAttribute("role", "tablist");

	const shown = (project: SessionProject) => pending || project.on[tab]!;
	const query = ui.query.trim().toLowerCase();
	const matching = projects.filter((project) =>
		project.name.toLowerCase().includes(query),
	);
	const count = projects.filter(shown).length;
	// While the default is still pending, a first change applies it too.
	const set = (ids: string[], on: boolean) =>
		ids.length &&
		act(
			on ? "sessions-on" : "sessions-off",
			`${tab}|${ids.join(",")}${pending ? `|${all.join(",")}` : ""}`,
		);

	const search = el("input", "search");
	search.type = "search";
	search.placeholder = "Search projects";
	search.value = ui.query;
	search.dataset.key = "sessions-search";
	search.oninput = () => {
		ui.query = search.value;
		redraw();
	};

	const recent = Date.now() - 30 * DAY;
	const row = (project: SessionProject) => {
		const box = el("input");
		box.type = "checkbox";
		box.checked = shown(project);
		box.disabled = Boolean(ran?.working);
		box.dataset.key = `project:${project.id}`;
		box.onchange = () => set([project.id], box.checked);
		return el(
			"label",
			"pick",
			box,
			el("span", "name", project.name),
			el("small", "", ago(project.updatedAt)),
		);
	};
	const fresh = matching.filter(
		(project) => Date.parse(project.updatedAt) >= recent,
	);
	const older = matching.filter(
		(project) => !(Date.parse(project.updatedAt) >= recent),
	);
	const list = el(
		"div",
		"picks",
		fresh.length > 0 && older.length > 0 && el("div", "label", "Recent"),
		...fresh.map(row),
		fresh.length > 0 && older.length > 0 && el("div", "label", "Older"),
		...older.map(row),
		matching.length === 0 && el("p", "empty", "No project matches."),
	);
	list.setAttribute("role", "group");
	list.setAttribute("aria-label", `Projects for ${EXECUTOR_NAMES[tab] ?? tab}`);
	// Arrows move between projects; space toggles; Cmd+A chooses all.
	list.onkeydown = (event) => {
		const boxes = [
			...list.querySelectorAll<HTMLInputElement>("input[type=checkbox]"),
		];
		const at = boxes.indexOf(document.activeElement as HTMLInputElement);
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			boxes[
				Math.max(
					0,
					Math.min(boxes.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)),
				)
			]?.focus();
		}
		if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			set(
				matching.map((project) => project.id),
				true,
			);
		}
	};

	return el(
		"div",
		"sessions",
		main,
		el(
			"div",
			"group",
			el("div", "bar", tabs),
			el(
				"div",
				"bar",
				search,
				el("small", "count", `${count} of ${projects.length}`),
				button(
					"All",
					"quiet",
					() =>
						set(
							matching.filter((project) => !project.on[tab]).map((p) => p.id),
							true,
						),
					Boolean(ran?.working),
					{ pending: "All", key: "sessions-all" },
				),
				button(
					"None",
					"quiet",
					() =>
						set(
							matching.filter((project) => project.on[tab]).map((p) => p.id),
							false,
						),
					Boolean(ran?.working),
					{ pending: "None", key: "sessions-none" },
				),
			),
			list,
		),
	);
}

/** Puts focus back on the element with the same key after a redraw. */
export function keepFocus(redraw: () => void): void {
	const active = document.activeElement as HTMLElement | null;
	const key = active?.dataset?.key;
	const caret =
		active instanceof HTMLInputElement && active.type !== "checkbox"
			? active.selectionStart
			: null;
	redraw();
	if (!key) return;
	const again = [...document.querySelectorAll<HTMLElement>("[data-key]")].find(
		(node) => node.dataset.key === key,
	);
	again?.focus();
	if (again instanceof HTMLInputElement && caret !== null)
		again.setSelectionRange(caret, caret);
}
