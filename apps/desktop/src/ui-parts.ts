import type { PanelApi, PanelState } from "./api";
import { icon, type IconName } from "./icons";
import type { SessionProject, StepRun, ToolRow } from "./setup";
import type { RunnerRow } from "./status";

/**
 * What the Settings window and the first-run setup share: small element
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

export function button(
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
	void tedixShell.setup(action, id);

export const EXECUTOR_NAMES: Record<string, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	opencode: "OpenCode",
	"any-local": "Any coding tool",
};
export const TOOL_ICONS: Record<string, IconName> = {
	claude: "prompt",
	codex: "brackets",
	devin: "cube",
	opencode: "braces",
};
export const CONNECTOR_URL = "https://connect.mcp.tedix.dev/mcp";

export const orgName = (id: string) => id.replace(/^org_/, "");
export const person = ({ name, email }: { name: string; email: string }) =>
	name || email || "your account";

/** Tedix is in the tool, signed in, and a read inside the tool worked. */
export const connected = (tool: ToolRow) =>
	tool.found === "found" &&
	tool.tedix === "added" &&
	tool.enabled &&
	tool.account === "signed-in" &&
	tool.connection === "signed-in" &&
	tool.readVerified &&
	(tool.id !== "codex" || tool.hookTrust === "trusted");

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
	/** True only when added, signed in, a read worked and its runner runs. */
	ready: boolean;
	working?: string;
	error?: string;
	retry?: () => void;
	cancel?: () => void;
}

export function toolView(state: PanelState, tool: ToolRow): ToolView {
	const steps = state.setup.steps;
	const runner = runnerFor(state, tool);
	const keys = ["account", "add", "connect", "verify", "hooks"].map(
		(kind) => [kind, steps[`${kind}:${tool.id}`]] as const,
	);
	const running = state.setup.steps[`run:${tool.executor}`];
	const busy =
		keys.find(([, ran]) => ran?.working) ??
		(running?.working ? (["run", running] as const) : undefined);
	if (busy) {
		const [kind, ran] = busy;
		const stoppable = ["account", "connect", "verify", "hooks"].includes(kind);
		return {
			sub: "",
			ready: false,
			working:
				kind === "account" || kind === "connect"
					? "Waiting for your browser…"
					: (ran as StepRun).working,
			cancel: stoppable
				? () => act("cancel", `${kind === "hooks" ? "hooks" : kind}:${tool.id}`)
				: undefined,
		};
	}
	const failed =
		keys.find(([, ran]) => ran?.error) ??
		(running?.error ? (["run", running] as const) : undefined);
	const again: Record<string, Parameters<typeof act>[0]> = {
		account: "account-sign-in",
		add: "add",
		connect: "connect",
		verify: "verify",
		hooks: "trust-hooks",
		run: "run-tasks",
	};
	const base = failed
		? {
				error: (failed[1] as StepRun).error,
				retry: () => act(again[failed[0]]!, tool.id),
			}
		: {};
	const plain = (label: string, action: Parameters<typeof act>[0]) =>
		button(label, "plain", () => act(action, tool.id));

	if (tool.found === "no-command")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `The ${tool.name} command was not found. Install ${tool.name} again.`,
		};
	if (tool.tedix === "checking")
		return { ...base, ready: false, sub: "Checking…" };
	if (tool.account === "signed-out")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `Not signed in to ${tool.name}`,
			action: tool.canSignInAccount
				? plain("Sign in", "account-sign-in")
				: undefined,
		};
	if (tool.tedix === "missing")
		return {
			...base,
			ready: false,
			sub: "Tedix is not added yet",
			action: tool.canAdd ? plain("Add", "add") : undefined,
		};
	if (tool.tedix === "unknown")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: tool.note || "Could not check right now",
			action: button("Check again", "quiet", () => act("check")),
		};
	if (!tool.enabled)
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: `The Tedix plugin is off in ${tool.name}`,
			action: button("Check again", "quiet", () => act("check")),
		};
	if (tool.id === "codex" && tool.hookTrust !== "trusted")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: "Trust the Tedix hooks in Codex",
			action: plain("Open hooks", "trust-hooks"),
		};
	if (tool.connection === "signed-out")
		return {
			...base,
			ready: false,
			tone: "warn",
			sub: "Not signed in to Tedix",
			action: tool.canSignIn ? plain("Sign in", "connect") : undefined,
		};
	if (!connected(tool)) {
		const checkable = tool.id === "codex" || tool.id === "claude";
		return {
			...base,
			ready: false,
			sub: checkable
				? "Signed in; a Tedix read is not checked yet"
				: tool.connection === "signed-in"
					? "Signed in to Tedix"
					: "Sign in to Tedix once",
			action: checkable
				? plain("Check read", "verify")
				: tool.canSignIn && tool.connection !== "signed-in"
					? plain("Sign in", "connect")
					: undefined,
		};
	}
	if (!runner?.enabled)
		return { ...base, ready: false, sub: "Connected. Not running tasks." };
	if (!runner.running)
		return {
			...base,
			ready: false,
			tone: runner.problem ? "warn" : undefined,
			sub: state.app.paused
				? "Runners are paused"
				: (runner.problem ?? "Starting…"),
		};
	return { ...base, ready: true, tone: "good", sub: "Ready" };
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

export const READY_MARK = () => el("span", "done", icon("check", 13), "Ready");

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
	if (!tools.length)
		return el("p", "empty", "No coding tool was found on this Mac.");
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
							button("Retry", "link", () => act("check")),
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
			el(
				"div",
				"text",
				el("div", "title", "Show my coding sessions in Tedix"),
				el(
					"div",
					"sub",
					"Status and replies of your sessions appear in their Tedix project.",
				),
			),
			el(
				"div",
				"control",
				ran?.working && el("span", "spinner"),
				toggle(
					"Show my coding sessions in Tedix",
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
				el("small", "count", `${count} of ${projects.length} shown in Tedix`),
				button("All", "quiet", () =>
					set(
						matching.filter((project) => !project.on[tab]).map((p) => p.id),
						true,
					),
				),
				button("None", "quiet", () =>
					set(
						matching.filter((project) => project.on[tab]).map((p) => p.id),
						false,
					),
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
