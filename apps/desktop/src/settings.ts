import {
	type Appearance,
	type PanelApi,
	type PanelState,
	type SettingsSection,
} from "./api";
import { icon, type IconName } from "./icons";
import type { Routing } from "./setup";
import {
	act,
	button,
	type Child,
	checkAgain,
	CONNECTOR_URL,
	EXECUTOR_NAMES,
	el,
	foundTools,
	keepFocus,
	onButtonsChange,
	orgName,
	otherRunners,
	person,
	READY_MARK,
	runnerFor,
	type SessionsUi,
	sessionsPanel,
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
/** The rules file row shows only after the person asks for it. */
let routingAdvanced = false;

/** One line in a card: what it is on the left, its control on the right. */
interface Item {
	title: string;
	sub?: Child;
	tone?: "good" | "warn" | "bad";
	glyph?: IconName;
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
	items: Item[];
	/** A whole element instead of items, for the Sessions list. */
	body?: HTMLElement;
}
interface Section {
	id: SettingsSection;
	name: string;
	glyph: IconName;
	groups: (now: PanelState) => Group[];
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

function fail(text: string | undefined, retry?: () => void): Child {
	return (
		text &&
		el(
			"div",
			"fail",
			el("span", "", text),
			retry && button("Retry", "link", retry),
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
					? `Update ready · ${now.app.updateReady ?? `command-line tool ${now.app.cliOffer}`}`
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
	const enabled = now.status.runners.filter((runner) => runner.enabled);
	const problems = [
		cli.kind === "missing" &&
			"Tedix's helper is missing. Install the app again.",
		!(now.setup.signedIn && now.setup.app.state === "in") && "Not signed in.",
		now.setup.reach !== "ok" &&
			now.setup.reach !== "checking" &&
			"Tedix could not be reached.",
		!now.app.paused &&
			enabled.some((runner) => !runner.running) &&
			"Tasks are not running.",
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

function tools(now: PanelState): Group[] {
	const found = foundTools(now);
	const chat: Group = {
		title: "Chat apps",
		items: [
			{
				title: "Claude",
				glyph: "bubble",
				sub: "Add Tedix as a connector.",
				control: [
					button(
						"Copy address",
						"plain",
						() => tedixShell.copy(CONNECTOR_URL),
						false,
						{ done: "Copied" },
					),
					button(
						"Open",
						"quiet",
						() => void tedixShell.open("claude-connectors"),
						false,
						{ key: "open-claude" },
					),
				],
				words: "claude app connector",
			},
			{
				title: "ChatGPT",
				glyph: "bubble-spark",
				sub: "Turn on Tedix in the Plugins Directory.",
				control: [
					button(
						"Open",
						"plain",
						() => void tedixShell.open("chatgpt"),
						false,
						{
							key: "open-chatgpt",
						},
					),
				],
			},
		],
	};
	const rows: Item[] = found.map((tool) => {
		const view = toolView(now, tool);
		const runner = runnerFor(now, tool);
		const on = Boolean(runner?.enabled);
		// Held back by its own limit, such as out of credits until a time.
		const limit = on ? now.setup.routing?.limits?.[tool.executor] : undefined;
		// What the tool itself reports: plan, each limit used and its reset.
		const report = on ? now.setup.routing?.usage?.[tool.executor] : undefined;
		const usageText = report ? plainUsage(report.text, tool.name) : "";
		const usage = usageText
			? { text: usageText, near: report?.near }
			: undefined;
		return {
			title: tool.name,
			glyph: TOOL_ICONS[tool.id] ?? "terminal",
			sub: view.working
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
						: view.sub,
			tone: view.working
				? undefined
				: limit || usage?.near
					? "warn"
					: view.tone,
			control: [
				view.cancel && button("Cancel", "quiet", view.cancel),
				!view.working && (view.ready && !limit ? READY_MARK() : view.action),
				toggle(
					`Use ${tool.name} for tasks`,
					on,
					(next) => useForTasks(now, tool, next),
					!now.setup.signedIn,
				),
			],
			below: fail(view.error, view.retry),
			words: "sign in add check",
		};
	});
	for (const runner of otherRunners(now))
		rows.push({
			title: EXECUTOR_NAMES[runner.executor] ?? "Other tool",
			glyph: "bolt",
			control: [
				toggle(
					`Use ${EXECUTOR_NAMES[runner.executor] ?? "this tool"} for tasks`,
					runner.enabled,
					(on) => void tedixShell.set(runner.index, "enabled", on),
				),
			],
		});
	const again = checkAgain();
	if (!found.length && !rows.length)
		return [
			chat,
			{
				title: "Agents",
				items: [
					{
						title: "None found",
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
							again,
						],
					},
				],
			},
		];
	return [
		chat,
		{ title: "Agents", column: "Use for tasks", items: rows },
		...(now.setup.routing ? [routingGroup(now.setup.routing)] : []),
		{
			items: [
				{
					title: "Project folder",
					sub: now.setup.repo.split("/").at(-1) || undefined,
					control: [
						button("Choose…", "plain", () => act("choose-folder"), false, {
							pending: "Choosing…",
						}),
					],
					words: "repository repo",
				},
				{
					title: "Look for agents again",
					control: [again],
					words: "check refresh",
				},
			],
		},
	];
}

const toolNames = (tools: string[]) =>
	tools.map((tool) => EXECUTOR_NAMES[tool] ?? tool).join(", then ");

/**
 * Which tool takes which tasks, in plain words: one summary line, whose
 * setting it is, and a row per kind of task only when the kinds differ.
 */
function routingGroup(routing: Routing): Group {
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
						title: "Clef picks the agent; rules are the backup.",
						plain: true,
						words: "clef routing",
					},
				]
			: []),
		{
			title: same
				? `${clef ? "Backup: every" : "Right now every"} task goes to ${toolNames(routing.rules[0]!.tools)}.`
				: clef
					? "Backup: each kind of task goes to its own tool."
					: "Each kind of task goes to its own tool.",
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
	if (routing.file && routingAdvanced)
		items.push({
			title: "Rules file",
			control: [
				button("Open", "plain", () => void tedixShell.action("open-routing")),
			],
			words: "routing rules file",
		});
	else if (routing.file)
		items.push({
			title: "Advanced",
			plain: true,
			control: [
				button("Show", "quiet", () => {
					routingAdvanced = true;
					draw();
				}),
			],
		});
	return { title: "Who takes which tasks", items };
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
	const enabled = status.runners.filter((runner) => runner.enabled);
	const stopped =
		!now.app.paused &&
		(!now.app.running || enabled.some((runner) => !runner.running));
	const runs = status.activeRuns;
	return [
		{
			items: [
				serving !== undefined && { title: "Name", control: [name] },
				serving !== undefined && {
					title: "Let tedis edit files and run commands",
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
				{
					title: now.app.paused
						? "Tasks are paused"
						: stopped
							? "Tasks are not running"
							: runs
								? `${runs} ${runs === 1 ? "task" : "tasks"} running`
								: "Ready for tasks",
					tone: stopped ? "warn" : undefined,
					control: [
						now.app.paused
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
				},
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
	{ id: "tools", name: "Agents", glyph: "terminal", groups: tools },
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
	if (id === "mac")
		return (
			!now.app.paused && now.status.runners.some((r) => r.enabled && !r.running)
		);
	return false;
}

function itemNode(item: Item): HTMLElement {
	return el(
		"div",
		"item",
		item.glyph && el("span", "glyph", icon(item.glyph, 18)),
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
				el("h1", "", active.name),
				...active.groups(now).map((group) => groupNode(group)),
			];
	page.replaceChildren(...body);
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
