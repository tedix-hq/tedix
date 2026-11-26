import {
	type Appearance,
	type PanelApi,
	type PanelState,
	type SettingsSection,
} from "./api";
import { icon, type IconName } from "./icons";
import type { Routing } from "./setup";
import { tedixAccountSummary } from "./tool-connection";
import {
	act,
	button,
	CHAT_CONNECTED,
	CHATGPT_CHAT_SUB,
	chatgptChatSteps,
	type Child,
	checkAgain,
	CLAUDE_PLUGIN_SUB,
	claudePluginSteps,
	EXECUTOR_NAMES,
	el,
	foundTools,
	keepFocus,
	namedAgentTool,
	onButtonsChange,
	orgName,
	otherRunners,
	person,
	READY_MARK,
	runnerFor,
	type SessionsUi,
	sessionsPanel,
	TOOL_APPS,
	TOOL_ICONS,
	toggle,
	toolView,
	useForTasks,
} from "./ui-parts";

/**
 * Settings, a panel over the main window: every setting of the app. A
 * sidebar with search, the sections in groups and the account; on the
 * right, rows with the title on the left and the control on the right.
 * It speaks only about problems and actions.
 */
declare const tedixShell: PanelApi;
const nav = document.getElementById("nav")!;
const account = document.getElementById("account")!;
const page = document.getElementById("page")!;
const search = document.getElementById("search") as HTMLInputElement;
const done = document.getElementById("done")!;
search.before(icon("search", 16));
done.append(icon("close", 18));

let state: PanelState | undefined;
/** Sections that were merged open where their rows went. */
const MOVED: Record<string, SettingsSection> = {
	about: "general",
	sessions: "mac",
};
const known = (id: string): SettingsSection =>
	MOVED[id] ??
	((["general", "mac", "tools"].includes(id)
		? id
		: "general") as SettingsSection);
let section: SettingsSection = known(location.hash.slice(1));
let nameDraft: string | undefined;
const sessionsUi: SessionsUi = { query: "" };
/** The Agents page's technical rows show only after the person opens them. */
let agentsAdvanced = false;

/** One line in a card: what it is on the left, its control on the right. */
interface Item {
	title: string;
	sub?: Child;
	tone?: "good" | "warn" | "bad";
	glyph?: IconName;
	/** An image in place of the glyph: an app's own icon. */
	image?: string;
	control?: Child[];
	/** Shown under the line: a failure with its retry, a list. */
	below?: Child;
	/** Extra words the search matches. */
	words?: string;
	/** A sentence rather than a name: normal weight. */
	plain?: boolean;
}
interface Group {
	title?: string;
	/** Right-aligned over the controls, like a column heading. */
	column?: string;
	/** A control at the right end of the heading, such as Show. */
	headingControl?: Child;
	items: Item[];
	/** A whole element instead of items, for the Sessions list. */
	body?: HTMLElement;
}
interface Section {
	id: SettingsSection;
	name: string;
	glyph: IconName;
	groups: (now: PanelState) => Group[];
	/** A control beside the page title. */
	action?: () => Child;
	/** One sentence under the page title. */
	intro?: string;
	/** Starts a new group in the sidebar, under a thin line. */
	split?: boolean;
}

/** Plays the short fade-in of the section pane. */
function enter(): void {
	page.classList.remove("enter");
	void page.offsetWidth;
	page.classList.add("enter");
}

const go = (id: SettingsSection) => {
	const moved = id !== section;
	section = id;
	search.value = "";
	draw();
	if (moved) enter();
	page.parentElement!.scrollTop = 0;
	// Each section shows what is true now, not what was sent a while ago.
	void tedixShell.state().then(receive);
};

function fail(
	text: string | undefined,
	retry?: () => void,
	details?: string,
): Child {
	return (
		text &&
		el(
			"div",
			"fail",
			el("span", "", text),
			retry && button("Retry", "link", retry),
			details &&
				button("Details", "link", () => tedixShell.copy(details), false, {
					done: "Details copied",
					key: `details:${text}`,
				}),
		)
	);
}

/** "just now", "5 min ago", "at 14:02": when the last look for updates ended. */
function when(at: number | undefined): string {
	if (!at) return "";
	const minutes = Math.floor((Date.now() - at) / 60_000);
	if (minutes < 1) return "checked just now";
	if (minutes < 60) return `checked ${minutes} min ago`;
	return `checked at ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The version row says what the sidebar entry says: checking, downloading
 * with its percent, ready, failed with Try again, or up to date and when.
 */
function versionItem(now: PanelState): Item {
	const { cli } = now.setup;
	const { update } = now.app;
	const failedCli = cli.update?.ok === false && !cli.updating;
	const working = cli.updating
		? "Updating…"
		: update.kind === "working"
			? update.text
			: "";
	const ready = now.app.updateReady || now.app.cliOffer;
	const apply = (label: string, kind: "primary" | "plain") =>
		button(label, kind, () => tedixShell.action("apply-update"), false, {
			pending: "Updating…",
			key: "apply-update",
		});
	const check = (label: string) =>
		button(label, "plain", () => tedixShell.action("check-updates"), false, {
			pending: "Checking…",
			key: "check-updates",
		});
	const sub: Child = working
		? el("span", "live", el("span", "spinner"), working)
		: update.kind === "failed"
			? now.app.updateFailure || "The update did not finish."
			: update.kind === "done"
				? update.text
				: ready
					? `Update ready${now.app.updateReady ? ` · ${now.app.updateReady}` : ""}`
					: now.app.checked && now.app.checked !== "Up to date"
						? now.app.checked
						: ["Up to date", when(now.app.checkedAt)]
								.filter(Boolean)
								.join(" · ");
	return {
		title: `Tedix ${now.app.version}`,
		sub,
		tone:
			update.kind === "failed"
				? "bad"
				: !working &&
					  !ready &&
					  now.app.checked &&
					  now.app.checked !== "Up to date"
					? "warn"
					: update.kind === "done"
						? "good"
						: undefined,
		control: [
			working
				? button(
						working.replace(/ \d+%$/, "").replace(/ for updates…$/, "…"),
						"plain",
						() => undefined,
						true,
						{ key: "update-working" },
					)
				: update.kind === "failed"
					? apply("Try again", "plain")
					: ready
						? apply(
								now.app.updateReady ? "Restart to update" : "Update",
								"primary",
							)
						: check("Check for updates"),
			failedCli &&
				cli.other &&
				button(
					"Go back",
					"quiet",
					() => tedixShell.action("cli-back"),
					now.busy,
					{ pending: "Going back…" },
				),
		],
		words: "version update about",
	};
}

/** Only a problem earns a row; when all is well there is nothing to say. */
function problemItem(now: PanelState): Item | undefined {
	const { cli } = now.setup;
	const problems = [
		cli.kind === "missing" &&
			"Tedix could not finish setting up this Mac. Quit and open Tedix again; if this stays, install the app again.",
		!(now.setup.signedIn && now.setup.app.state === "in") && "Not signed in.",
		// Only a check that ran and got no answer; a Mac that is not signed
		// in is never checked, and "Not signed in." already says so.
		now.setup.reach === "unavailable" && "Tedix could not be reached.",
		tasksStopped(now) && "Tasks are not running.",
	].filter((line): line is string => Boolean(line));
	if (!problems.length) return undefined;
	const details = [
		`Tedix ${now.app.version}`,
		now.app.updateFailure,
		`Command-line tool ${cli.version || "not found"} (${cli.kind})`,
		now.summary,
		cli.update?.text,
		...problems,
		now.setup.reachDetail,
	]
		.filter(Boolean)
		.join("\n");
	return {
		title: problems[0]!,
		tone: "warn",
		sub: problems.length > 1 ? problems.slice(1).join(" ") : undefined,
		control: [
			button("Copy details", "quiet", () => tedixShell.copy(details), false, {
				done: "Copied",
			}),
		],
		words: "diagnostics health problem",
	};
}

/**
 * The runners are down for a reason, not still starting: right after the app
 * starts, they are off with no problem for a few seconds.
 */
const tasksStopped = (now: PanelState) =>
	!now.app.paused &&
	(Boolean(now.app.problem) ||
		now.status.runners.some(
			(runner) => runner.enabled && !runner.running && runner.problem,
		));
const tasksStarting = (now: PanelState) =>
	!now.app.paused &&
	!tasksStopped(now) &&
	now.status.runners.some((runner) => runner.enabled && !runner.running);

function general(now: PanelState): Group[] {
	const appearance = el(
		"div",
		"segmented",
		...(["system", "light", "dark"] as Appearance[]).map((mode) => {
			const node = button(
				mode === "system" ? "System" : mode === "light" ? "Light" : "Dark",
				"plain",
				() => void tedixShell.appearance(mode),
			);
			node.className = "seg";
			node.setAttribute("aria-pressed", String(now.app.appearance === mode));
			return node;
		}),
	);
	return [
		{
			items: [versionItem(now), problemItem(now)].filter(Boolean) as Item[],
		},
		{
			items: [
				now.openAtLogin !== undefined && {
					title: "Open at login",
					control: [
						toggle(
							"Open at login",
							now.openAtLogin,
							(on) => void tedixShell.openAtLogin(on),
						),
					],
				},
				{
					title: "Appearance",
					control: [appearance],
					words: "theme dark light mode",
				},
				{
					title: "Setup guide",
					control: [
						button(
							"Open",
							"plain",
							() => void tedixShell.action("setup-window"),
							false,
							{ key: "setup-window" },
						),
					],
					words: "set up onboarding welcome sign in",
				},
			].filter(Boolean) as Item[],
		},
	];
}

/**
 * The tool's own usage report, cut to what a person can act on: how much of
 * each limit is used and when it resets, e.g. "8% of weekly limit used ·
 * resets Nov 30". Plan names, credits, costs and notes about what a tool
 * does not report are left out; with nothing left, there is no line.
 */
function plainUsage(text: string, toolName: string): string {
	const prefix = new RegExp(`^${toolName.replace(/[^\w]/g, "\\$&")}\\s+`, "i");
	const windows = [
		...text.matchAll(
			/([A-Za-z0-9][\w -]*?): (\d+)% used(?: \([^)]*\))?(?:, resets ([A-Z][a-z]{2} \d{1,2}))?/g,
		),
	].map(([, name = "", used, reset]) => {
		const period = name.trim().replace(prefix, "").toLowerCase();
		const label = /^\d+h$/.test(period)
			? `${period.slice(0, -1)}-hour`
			: period;
		return `${used}% of ${label} limit used${reset ? ` · resets ${reset}` : ""}`;
	});
	return windows.slice(0, 2).join(" · ");
}

/** What setup found on this Mac, to send when an agent will not connect. */
const setupDetails = (now: PanelState): Item => ({
	title: "Get help",
	sub:
		now.helpNote ||
		"If an agent will not connect, send Tedix support what Tedix found on this Mac. You see it and approve it before it is sent.",
	control: [
		button("Get help", "plain", () => tedixShell.action("get-help"), false, {
			pending: "Opening…",
			key: "get-help",
		}),
		button(
			"Copy details",
			"quiet",
			() => tedixShell.copy(now.setup.report),
			false,
			{ done: "Copied" },
		),
	],
	words: "diagnostics support report copy",
});

const AGENT_APPS = [
	["chatgpt", "ChatGPT"],
	["claude", "Claude"],
	["devin", "Devin"],
	["opencode", "OpenCode"],
] as const;
type AgentApp = (typeof AGENT_APPS)[number][0];

function tools(now: PanelState): Group[] {
	const found = foundTools(now);
	const appItems = new Map<AgentApp, Item[]>();
	const loose: Item[] = [];
	const add = (app: AgentApp | undefined, item: Item) => {
		if (!app) return loose.push(item);
		appItems.set(app, [...(appItems.get(app) ?? []), item]);
	};
	for (const tool of found) {
		const named = namedAgentTool(tool);
		const view = toolView(now, named);
		const runner = runnerFor(now, named);
		const on = Boolean(runner?.enabled);
		// Held back by its own limit, such as out of credits until a time.
		const limit = on ? now.setup.routing?.limits?.[named.executor] : undefined;
		// What the tool itself reports: plan, each limit used and its reset.
		const report = on ? now.setup.routing?.usage?.[named.executor] : undefined;
		const usageText = report ? plainUsage(report.text, named.name) : "";
		const usage = usageText
			? { text: usageText, near: report?.near }
			: undefined;
		const identity = tedixAccountSummary(
			named.tedixAccount,
			now.setup.app.state === "in" ? now.setup.app.email : "",
		);
		const app = TOOL_APPS[named.id];
		// The header's refresh does this; a row needs no button of its own.
		const action = view.action?.classList.contains("recheck")
			? undefined
			: view.action;
		add(app, {
			title: named.name,
			glyph: TOOL_ICONS[named.id] ?? "terminal",
			image: app && now.setup.appIcons?.[app],
			sub: el(
				"span",
				"",
				el("div", "", identity.text),
				!identity.mismatch &&
					named.grant?.lastSuccessfulCallAt &&
					el(
						"div",
						"",
						`Last successful call: ${new Date(named.grant.lastSuccessfulCallAt).toLocaleString()}`,
					),
				el(
					"div",
					"",
					view.working
						? el("span", "live", el("span", "spinner"), view.working)
						: limit
							? limit
							: usage
								? el(
										"span",
										"",
										el("div", "", usage.text),
										view.sub ? el("div", "", view.sub) : null,
									)
								: [
										named.bothInstalled ? "Connects the desktop app." : "",
										view.sub,
									]
										.filter(Boolean)
										.join(" "),
				),
			),
			tone: identity.mismatch
				? "warn"
				: view.working
					? undefined
					: limit || usage?.near
						? "warn"
						: view.tone,
			control: [
				view.cancel && button("Cancel", "quiet", view.cancel),
				named.found === "found" &&
					named.tedix === "added" &&
					named.connection === "signed-in" &&
					named.readVerified &&
					!view.working &&
					!action &&
					button("Check account", "quiet", () => act("verify", named.id)),
				// Held back from tasks, its connection still works: say so, so the
				// row does not look broken beside the line that says why.
				view.ready ? READY_MARK(limit ? "Connected" : "Ready") : action,
				// Takes Tedix out so it can be connected fresh; it asks first.
				named.tedix === "added" && removeButton(named),
				toggle(
					`Let ${named.name} work on Tedix tasks from this Mac`,
					on,
					(next) => useForTasks(now, named, next),
					!now.setup.signedIn,
				),
			],
			below: fail(view.error, view.retry, view.details),
			words: `${app ?? ""} ${named.name} sign in add check`,
		});
	}
	const chat = now.setup.chatConnected ?? {};
	if (now.setup.desktopApps.chatgpt)
		add("chatgpt", {
			title: "ChatGPT (Chat)",
			glyph: "bubble",
			image: now.setup.appIcons?.chatgpt,
			sub: chat.chatgpt ? CHAT_CONNECTED("ChatGPT") : CHATGPT_CHAT_SUB,
			control: chat.chatgpt ? [READY_MARK("Connected")] : undefined,
			below: chat.chatgpt ? undefined : chatgptChatSteps(),
			words: "chatgpt chat plugin custom mcp server connector",
		});
	if (now.setup.desktopApps.claude)
		add("claude", {
			title: "Claude (Cowork)",
			glyph: "bubble",
			image: now.setup.appIcons?.claude,
			sub: chat.claude ? CHAT_CONNECTED("Claude") : CLAUDE_PLUGIN_SUB,
			control: chat.claude ? [READY_MARK("Connected")] : undefined,
			below: chat.claude ? undefined : claudePluginSteps(),
			words: "claude chat cowork plugin marketplace",
		});
	for (const runner of otherRunners(now))
		loose.push({
			title: EXECUTOR_NAMES[runner.executor] ?? "Other tool",
			glyph: "bolt",
			control: [
				toggle(
					`Let ${EXECUTOR_NAMES[runner.executor] ?? "this tool"} work on Tedix tasks from this Mac`,
					runner.enabled,
					(on) => void tedixShell.set(runner.index, "enabled", on),
				),
			],
		});
	const groups: Group[] = AGENT_APPS.map(([app, title]) => ({
		title,
		items: appItems.get(app) ?? [],
	})).filter((group) => group.items.length);
	if (loose.length)
		groups.push({
			title: "Other runners",
			items: loose,
		});
	if (!groups.length)
		return [
			{
				title: "Agents",
				items: [
					{
						title: "None found",
						sub: "An agent is a coding tool on this Mac that Tedix can hand code tasks to. Tedix works for everything else without one. Install Claude Code or Codex and it shows up here.",
						control: [
							button(
								"Get Claude Code",
								"quiet",
								() => void tedixShell.open("install-claude-code"),
							),
							button(
								"Get Codex",
								"quiet",
								() => void tedixShell.open("install-codex"),
							),
						],
					},
					setupDetails(now),
				],
			},
		];
	// Searching looks inside Advanced too, so a match is never hidden.
	const open = agentsAdvanced || search.value.trim() !== "";
	return [
		...groups,
		{ title: "Help", items: [setupDetails(now)] },
		{
			title: "Advanced",
			headingControl: button(open ? "Hide" : "Show", "quiet", () => {
				agentsAdvanced = !agentsAdvanced;
				draw();
			}),
			items: open
				? [
						...(now.setup.routing ? routingItems(now.setup.routing) : []),
						{
							title: "Project folder",
							sub:
								now.setup.repo.split("/").at(-1) ||
								"Only for code tasks. Other tasks need no folder.",
							control: [
								button("Choose…", "plain", () => act("choose-folder"), false, {
									pending: "Choosing…",
								}),
								(now.setup.repo || now.setup.steps.folder?.error) &&
									button("Use without a folder", "quiet", () =>
										act("clear-folder"),
									),
							],
							below: fail(now.setup.steps.folder?.error),
							words: "repository repo folder",
						},
					]
				: [],
		},
	];
}

/** A labelled button that takes Tedix out of an agent, after a confirmation. */
function removeButton(tool: { id: string; name: string }): HTMLButtonElement {
	const label = `Remove Tedix from ${tool.name}`;
	const node = button(
		"Remove Tedix",
		"quiet",
		() => act("remove", tool.id),
		false,
		{
			pending: "Removing…",
			key: `remove:${tool.id}`,
		},
	);
	node.setAttribute("aria-label", label);
	node.title = label;
	return node;
}

const toolNames = (tools: string[]) =>
	tools.map((tool) => EXECUTOR_NAMES[tool] ?? tool).join(", then ");

/**
 * Which tool takes which tasks, in plain words: one summary line, whose
 * setting it is, and a row per kind of task only when the kinds differ.
 */
function routingItems(routing: Routing): Item[] {
	const same = routing.rules.every(
		(rule) => toolNames(rule.tools) === toolNames(routing.rules[0]!.tools),
	);
	const changed = routing.changedAt
		? new Date(routing.changedAt).toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
			})
		: "";
	const clef = routing.clef;
	const items: Item[] = [
		...(clef
			? [
					{
						title:
							"Tedix picks the best agent for each task. If it cannot, these rules decide.",
						plain: true,
						words: "clef routing",
					},
				]
			: []),
		{
			title: same
				? `${clef ? "Otherwise every" : "Right now every"} task goes to ${toolNames(routing.rules[0]!.tools)}.`
				: clef
					? "Otherwise each kind of task goes to its own agent."
					: "Each kind of task goes to its own agent.",
			plain: true,
			sub: routing.file
				? `Set on this Mac${changed ? ` on ${changed}` : ""}.`
				: "Tedix's default.",
			words: "routing who takes tasks",
		},
	];
	if (!same)
		for (const rule of routing.rules)
			items.push({
				title: `${rule.kind} → ${toolNames(rule.tools)}`,
				plain: true,
				words: "routing",
			});
	if (routing.file)
		items.push({
			title: "Rules file",
			control: [
				button("Open", "plain", () => void tedixShell.action("open-routing")),
			],
			words: "routing rules file",
		});
	return items;
}

function mac(now: PanelState): Group[] {
	const { status } = now;
	const serving = status.servingIndex;
	const name = el("input", "field");
	name.type = "text";
	name.placeholder = "Name";
	name.maxLength = 100;
	name.value = nameDraft ?? status.machineName;
	name.dataset.key = "machine-name";
	name.oninput = () => {
		nameDraft = name.value;
	};
	name.onchange = () => {
		nameDraft = undefined;
		if (serving !== undefined)
			void tedixShell.set(
				serving,
				"machineName",
				name.value.trim() || undefined,
			);
	};
	const stopped = tasksStopped(now);
	const starting = tasksStarting(now);
	const runs = status.activeRuns;
	// With no agent switched on for tasks there is nothing to run or pause.
	const noRunner = !status.runners.some((runner) => runner.enabled);
	const tasksRow: Item = noRunner
		? {
				title: "This Mac does not run tasks yet",
				sub: "To let it, sign in and switch an agent on under Agents.",
				words: "pause resume restart tasks",
			}
		: {
				title: now.app.paused
					? "Tasks are paused"
					: stopped
						? "Tasks are not running"
						: starting
							? "Starting tasks…"
							: runs
								? `${runs} ${runs === 1 ? "task" : "tasks"} running`
								: "Ready for tasks",
				tone: stopped ? "warn" : undefined,
				// Tedix keeps the Mac awake, but on battery macOS still sleeps
				// when the lid closes and running tasks wait until it opens.
				sub:
					now.app.onBattery && !now.app.paused && !stopped
						? "On battery, tasks pause when you close the lid. Plug this Mac in to keep them running."
						: undefined,
				control: [
					starting
						? undefined
						: now.app.paused
							? button(
									"Resume",
									"plain",
									() => tedixShell.action("restart"),
									now.busy,
									{ pending: "Resuming…", key: "runners" },
								)
							: stopped
								? button(
										"Restart",
										"plain",
										() => tedixShell.action("restart"),
										now.busy,
										{ pending: "Restarting…", key: "runners" },
									)
								: button(
										"Pause",
										"plain",
										() => tedixShell.action("pause"),
										now.busy,
										{ pending: "Pausing…", key: "runners" },
									),
				],
				words: "pause resume restart tasks",
			};
	return [
		{
			items: [
				serving !== undefined && { title: "Name", control: [name] },
				serving !== undefined && {
					title: "Let tedis edit files and run commands",
					sub: "Tedis are Tedix's own assistants. With this on, a tedi can change files and run commands for a task, in a work folder Tedix sets up for it on this Mac. Commands run as you, so they can reach what your Mac account can. Off: tedis can only read.",
					control: [
						toggle(
							"Let tedis edit files and run commands",
							status.machineWrite,
							(on) =>
								void tedixShell.set(
									serving,
									"machineWriteMode",
									on ? "allow" : "off",
								),
						),
					],
					words: "write machine",
				},
				tasksRow,
				...status.activeTasks.map((task): Item => ({
					title: task.title ?? "Task",
					sub: EXECUTOR_NAMES[task.executor ?? ""],
					control: [
						button(
							"Open",
							"quiet",
							() => void tedixShell.openWork(task.itemId),
							false,
							{ key: `task:${task.itemId}` },
						),
					],
				})),
			].filter(Boolean) as Item[],
		},
		{
			items: [
				{
					title: "Chat with a model on this Mac",
					control: [
						button(
							"Open",
							"plain",
							() => tedixShell.action("local-model"),
							false,
							{ pending: "Opening…", key: "local-model" },
						),
					],
					words: "local model ollama lm studio",
				},
				{
					title: "Try a sample workspace",
					control: [
						button(
							"Open",
							"plain",
							() => tedixShell.action("local-workspace"),
							false,
							{ pending: "Opening…", key: "local-workspace" },
						),
					],
					words: "sample offline local workspace",
				},
			],
		},
		{
			title: "Sessions",
			items: [],
			body: sessionsPanel(now, sessionsUi, () => keepFocus(draw), false),
		},
	];
}

const SECTIONS: Section[] = [
	{ id: "general", name: "General", glyph: "window", groups: general },
	{ id: "mac", name: "This Mac", glyph: "laptop", groups: mac },
	{
		id: "tools",
		name: "Agents",
		glyph: "terminal",
		groups: tools,
		intro:
			"Switch an agent on to let it work on your Tedix tasks from this Mac.",
		action: () => {
			// One look covers every agent; the app also looks on its own.
			const node = checkAgain("Look for agents again");
			if (node.getAttribute("aria-busy") !== "true")
				node.replaceChildren(icon("refresh", 16));
			node.classList.add("icon-only");
			node.title = "Look for agents again";
			node.setAttribute("aria-label", "Look for agents again");
			return node;
		},
	},
];

/** A section in the sidebar shows a dot when something there needs the person. */
function needs(now: PanelState, id: SettingsSection): boolean {
	if (id === "tools")
		return foundTools(now).some((tool) => {
			const view = toolView(now, tool);
			return Boolean(view.error) || (view.tone === "warn" && !view.working);
		});
	if (id === "general")
		return (
			now.setup.cli.kind === "missing" ||
			now.setup.cli.update?.ok === false ||
			now.app.update.kind === "failed" ||
			Boolean(now.app.updateReady || now.app.cliOffer)
		);
	if (id === "mac") return tasksStopped(now);
	return false;
}

function itemNode(item: Item): HTMLElement {
	return el(
		"div",
		"item",
		item.image
			? el(
					"span",
					"glyph",
					Object.assign(el("img", "app-icon"), { src: item.image, alt: "" }),
				)
			: item.glyph && el("span", "glyph", icon(item.glyph, 18)),
		el(
			"div",
			"text",
			el("div", item.plain ? "title plain" : "title", item.title),
			item.sub && el("div", `sub ${item.tone ?? ""}`, item.sub),
		),
		el("div", "control", ...(item.control ?? [])),
		item.below && el("div", "below", item.below),
	);
}

function groupNode(group: Group, heading?: string): HTMLElement {
	return el(
		"section",
		"",
		(group.title || heading || group.column) &&
			el(
				"div",
				"heading",
				el("span", "", heading ?? group.title ?? ""),
				group.column && el("span", "column", group.column),
				group.headingControl,
			),
		group.body ?? el("div", "group", ...group.items.map(itemNode)),
	);
}

const matches = (item: Item, query: string) =>
	[
		item.title,
		typeof item.sub === "string"
			? item.sub
			: (item.sub as Node | undefined)?.textContent,
		item.words,
	]
		.join(" ")
		.toLowerCase()
		.includes(query);

function accountNode(now: PanelState): HTMLElement {
	const { app } = now.setup;
	if (app.state !== "in") {
		const node = el(
			"button",
			"who signin",
			el("span", "avatar", icon("person", 14)),
			el(
				"div",
				"text",
				el("div", "title", "Sign in to Tedix"),
				app.waiting && el("div", "sub", "Waiting for your browser…"),
			),
		);
		node.type = "button";
		node.onclick = () => act("app-sign-in");
		return node;
	}
	const name = person(app);
	return el(
		"div",
		"who",
		el("span", "avatar", name.slice(0, 1).toUpperCase()),
		el(
			"div",
			"text",
			el("div", "title", name),
			el(
				"div",
				"sub",
				[
					app.email !== name && app.email,
					now.setup.organization && orgName(now.setup.organization),
				]
					.filter(Boolean)
					.join(" · "),
			),
		),
	);
}

function draw(): void {
	const now = state;
	if (!now) return;
	const query = search.value.trim().toLowerCase();
	account.replaceChildren(accountNode(now));

	const found = query
		? SECTIONS.map((entry) => ({
				entry,
				groups: entry
					.groups(now)
					.map((group) => ({
						...group,
						items: group.items.filter((item) => matches(item, query)),
						body:
							group.body && entry.name.toLowerCase().includes(query)
								? group.body
								: undefined,
					}))
					.filter((group) => group.items.length || group.body),
			})).filter(
				({ groups, entry }) =>
					groups.length || entry.name.toLowerCase().includes(query),
			)
		: [];

	nav.replaceChildren(
		...SECTIONS.flatMap((entry) => {
			const node = el(
				"button",
				"navitem",
				icon(entry.glyph, 16),
				el("span", "", entry.name),
				needs(now, entry.id) && el("span", "dot"),
			);
			node.type = "button";
			node.dataset.key = `nav:${entry.id}`;
			const current = query
				? found.some((hit) => hit.entry.id === entry.id)
				: entry.id === section;
			if (current) node.setAttribute("aria-current", "page");
			if (query && !current) node.classList.add("dim");
			node.onclick = () => go(entry.id);
			return entry.split ? [el("hr"), node] : [node];
		}),
	);

	const active = SECTIONS.find((entry) => entry.id === section)!;
	const body = query
		? found.length
			? found.flatMap(({ entry, groups }) =>
					(groups.length ? groups : [{ items: [] }]).map((group, index) =>
						groupNode(group, index === 0 ? entry.name : undefined),
					),
				)
			: [el("p", "empty", "No setting matches.")]
		: [
				el("div", "title-bar", el("h1", "", active.name), active.action?.()),
				active.intro && el("p", "intro", active.intro),
				...active.groups(now).map((group) => groupNode(group)),
			];
	page.replaceChildren(...body.filter((node): node is HTMLElement => !!node));
}

function redraw(): void {
	// Typing in a field must not be interrupted by the state the app sends.
	const typing = document.activeElement;
	if (
		typing instanceof HTMLInputElement &&
		typing.type === "text" &&
		typing !== search
	)
		return;
	keepFocus(draw);
}

search.oninput = () => {
	draw();
	enter();
};
const close = () => void tedixShell.action("close-settings");
done.onclick = close;
document.getElementById("backdrop")!.onclick = close;
// Opening Settings again plays its opening once more.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible") return;
	for (const node of document.querySelectorAll<HTMLElement>(
		".backdrop, .dialog",
	)) {
		node.style.animation = "none";
		void node.offsetWidth;
		node.style.animation = "";
	}
});
document.addEventListener("keydown", (event) => {
	if (event.key === "f" && (event.metaKey || event.ctrlKey)) {
		event.preventDefault();
		search.focus();
		search.select();
	}
	// Escape clears the search first, then goes back to Tedix.
	if (event.key === "Escape") {
		if (search.value) {
			search.value = "";
			draw();
		} else void tedixShell.action("close-settings");
	}
	if (
		(event.key === "ArrowDown" || event.key === "ArrowUp") &&
		(document.activeElement as HTMLElement | null)?.classList.contains(
			"navitem",
		)
	) {
		event.preventDefault();
		const at = SECTIONS.findIndex((entry) => entry.id === section);
		const next =
			SECTIONS[
				Math.max(
					0,
					Math.min(
						SECTIONS.length - 1,
						at + (event.key === "ArrowDown" ? 1 : -1),
					),
				)
			]!;
		go(next.id);
		(
			document.querySelector(
				`[data-key="nav:${next.id}"]`,
			) as HTMLElement | null
		)?.focus();
	}
});

onButtonsChange(() => keepFocus(draw));
tedixShell.onSection((next) => {
	go(known(next));
});
/** Draws the newest state; one that fails to draw is logged, not left half drawn. */
function receive(incoming: PanelState): void {
	state = incoming;
	try {
		redraw();
	} catch (error) {
		console.error("settings: could not draw", error);
	}
}
// The state the app pushes is newer than an answer asked for before it.
let pushed = false;
tedixShell.onState((incoming) => {
	pushed = true;
	receive(incoming);
});
void tedixShell.state().then((incoming) => {
	if (!pushed) receive(incoming);
});
