import {
	type Appearance,
	cliUpdateLine,
	type PanelApi,
	type PanelState,
	type SettingsSection,
} from "./api";
import { icon, type IconName } from "./icons";
import {
	act,
	button,
	type Child,
	CONNECTOR_URL,
	EXECUTOR_NAMES,
	el,
	foundTools,
	keepFocus,
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
 * Settings, inside the main window: every setting of the app. A sidebar
 * with search, the account and the sections; on the right, grouped cards
 * with the title on the left and the control on the right. It speaks only
 * about problems and actions.
 */
declare const tedixShell: PanelApi;
const nav = document.getElementById("nav")!;
const account = document.getElementById("account")!;
const page = document.getElementById("page")!;
const search = document.getElementById("search") as HTMLInputElement;

let state: PanelState | undefined;
let section: SettingsSection =
	(location.hash.slice(1) as SettingsSection) || "general";
let nameDraft: string | undefined;
const sessionsUi: SessionsUi = { query: "" };

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
}

const go = (id: SettingsSection) => {
	section = id;
	search.value = "";
	draw();
	page.scrollTop = 0;
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
			items: [
				now.openAtLogin !== undefined && {
					title: "Open Tedix at login",
					sub: "Starts in the menu bar and runs this Mac's runners.",
					control: [
						toggle(
							"Open Tedix at login",
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
					title: "New chat",
					sub: "Also a click on the menu bar icon.",
					control: [el("kbd", "", "⌘"), el("kbd", "", "N")],
					words: "shortcut hotkey menu bar",
				},
			].filter(Boolean) as Item[],
		},
		{
			items: [
				{
					title: "Set up this Mac",
					sub: "The first-run steps, from the start.",
					control: [
						button(
							"Open",
							"plain",
							() => void tedixShell.action("setup-window"),
						),
					],
					words: "onboarding welcome",
				},
			],
		},
	];
}

function tools(now: PanelState): Group[] {
	const found = foundTools(now);
	const chat: Group = {
		title: "Chat apps",
		items: [
			{
				title: "Claude app",
				glyph: "bubble",
				sub: "Add Tedix as a custom connector with this address.",
				control: [
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
				],
				words: "connector",
			},
			{
				title: "ChatGPT app",
				glyph: "bubble-spark",
				sub: "Open the Plugins Directory and turn on Tedix.",
				control: [
					button(
						"Open ChatGPT",
						"plain",
						() => void tedixShell.open("chatgpt"),
					),
				],
			},
		],
	};
	const rows: Item[] = found.map((tool) => {
		const view = toolView(now, tool);
		const runner = runnerFor(now, tool);
		const on = Boolean(runner?.enabled);
		return {
			title: tool.name,
			glyph: TOOL_ICONS[tool.id] ?? "terminal",
			sub: view.working
				? el("span", "live", el("span", "spinner"), view.working)
				: view.sub,
			tone: view.working ? undefined : view.tone,
			control: [
				view.cancel && button("Cancel", "quiet", view.cancel),
				!view.working && (view.ready ? READY_MARK() : view.action),
				on &&
					runner?.running &&
					button(
						"Restart",
						"quiet",
						() => void tedixShell.restartRunner(runner.index),
						now.busy,
					),
				toggle(
					`Use ${tool.name} for tasks`,
					on,
					(next) => useForTasks(now, tool, next),
					!now.setup.signedIn,
				),
			],
			below: fail(view.error, view.retry),
			words: "runner sign in add check read",
		};
	});
	for (const runner of otherRunners(now))
		rows.push({
			title: EXECUTOR_NAMES[runner.executor] ?? "Another runner",
			glyph: "bolt",
			sub: runner.enabled
				? runner.running
					? "Running"
					: (runner.problem ?? "Starting…")
				: "Off",
			control: [
				toggle(
					`Use ${EXECUTOR_NAMES[runner.executor] ?? "this runner"} for tasks`,
					runner.enabled,
					(on) => void tedixShell.set(runner.index, "enabled", on),
				),
			],
		});
	if (!found.length && !rows.length)
		return [
			chat,
			{
				items: [
					{
						title: "Coding tools: none found",
						sub: "Install one, then choose Check again.",
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
							button("Check again", "plain", () => act("check")),
						],
					},
				],
			},
		];
	return [
		chat,
		{ title: "Coding tools", column: "Use for tasks", items: rows },
		{
			items: [
				{
					title: "Project folder",
					sub: now.setup.repo || "Asked when you switch a tool on.",
					control: [button("Choose…", "plain", () => act("choose-folder"))],
					words: "repository repo",
				},
				{
					title: "Look for tools again",
					control: [button("Check again", "plain", () => act("check"))],
				},
			],
		},
	];
}

function sessions(now: PanelState): Group[] {
	return [
		{
			items: [],
			body: sessionsPanel(now, sessionsUi, () => keepFocus(draw), false),
		},
	];
}

function mac(now: PanelState): Group[] {
	const { status } = now;
	const serving = status.servingIndex;
	const name = el("input", "field");
	name.type = "text";
	name.placeholder = "Machine name";
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
	const running = enabled.filter((runner) => runner.running).length;
	const runs = status.activeRuns;
	return [
		{
			items:
				serving === undefined
					? [
							{
								title: "Machine name",
								sub: "Switch on a coding tool first.",
								control: [button("Coding tools", "plain", () => go("tools"))],
								words: "edit files run commands",
							},
						]
					: [
							{ title: "Machine name", control: [name] },
							{
								title: "Let tedis edit files and run commands",
								sub: status.machineWrite
									? "Tedis can change files here."
									: "Tedis can only look.",
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
								words: "write shell machine tools",
							},
						],
		},
		{
			title: "Runners",
			items: [
				{
					title: now.app.paused
						? "Paused"
						: `${running} of ${enabled.length} running`,
					tone:
						!now.app.paused && running < enabled.length ? "warn" : undefined,
					sub:
						now.app.problem ?? `${runs} ${runs === 1 ? "task" : "tasks"} now`,
					control: [
						now.app.paused || !now.app.running
							? button(
									"Resume",
									"plain",
									() => void tedixShell.action("restart"),
									now.busy,
								)
							: button(
									runs ? `Pause and stop ${runs}` : "Pause",
									"plain",
									() => void tedixShell.action("pause"),
									now.busy,
								),
					],
					words: "pause resume tasks",
				},
				...status.activeTasks.map((task): Item => ({
					title: task.title ?? "Task",
					sub: EXECUTOR_NAMES[task.executor ?? ""] ?? "",
					control: [
						button(
							"Open",
							"quiet",
							() => void tedixShell.openWork(task.itemId),
						),
					],
				})),
			],
		},
		{
			items: [
				{
					title: "Model on this Mac",
					sub: "Chat with Ollama or LM Studio, without Tedix Cloud.",
					control: [
						button(
							"Open",
							"plain",
							() => void tedixShell.action("local-model"),
						),
					],
					words: "local model ollama lm studio",
				},
				{
					title: "Local workspace",
					sub: "Tedix running from its source folder on this Mac.",
					control: [
						button(
							"Open",
							"plain",
							() => void tedixShell.action("local-workspace"),
						),
					],
					words: "developer local mode localhost",
				},
			],
		},
	];
}

function updates(now: PanelState): Group[] {
	const { cli } = now.setup;
	const running = [
		...new Set(
			now.status.runners
				.filter((runner) => runner.enabled && runner.version)
				.map((runner) => runner.version!),
		),
	];
	const behind =
		cli.version && running.some((version) => version !== cli.version);
	const failed = cli.update?.ok === false && !cli.updating;
	const line = cliUpdateLine(cli);
	return [
		{
			items: [
				{
					title: "Tedix",
					sub: `Version ${now.app.version}`,
					control: [
						now.app.updateReady || now.app.cliOffer
							? button(
									"Update",
									"primary",
									() => void tedixShell.action("apply-update"),
								)
							: button(
									"Check now",
									"plain",
									() => void tedixShell.action("check-updates"),
								),
					],
					words: "app update version",
				},
				{
					title: "Command-line tool",
					sub: cli.updating
						? el("span", "live", el("span", "spinner"), cli.updating)
						: cli.kind === "missing"
							? "Not found"
							: `Version ${cli.version || "unknown"}`,
					tone: cli.kind === "missing" ? "bad" : undefined,
					control: [
						cli.kind === "separate" &&
							button("Let the app manage it", "plain", () => act("manage-cli")),
						failed &&
							cli.other &&
							button(
								`Go back to ${cli.other}`,
								"plain",
								() => void tedixShell.action("cli-back"),
								now.busy,
							),
					],
					below: fail(
						cli.kind === "missing"
							? (cli.problem ?? "Install the Tedix app again, then open it.")
							: failed
								? cli.update?.text
								: (now.setup.steps.cli?.error ?? cli.access),
						now.setup.steps.cli?.error
							? () =>
									act(cli.kind === "separate" ? "manage-cli" : "restore-cli")
							: undefined,
					),
					words: "cli tedix version go back",
				},
				behind && {
					title: "Runners",
					tone: "warn",
					sub: `Still on ${running.join(", ")}`,
					control: [
						button(
							"Restart runners",
							"plain",
							() => void tedixShell.action("restart"),
							now.busy,
						),
					],
				},
				line &&
					!failed &&
					!cli.updating && {
						title: "Last check",
						sub: line,
					},
			].filter(Boolean) as Item[],
		},
	];
}

function advanced(now: PanelState): Group[] {
	const { cli } = now.setup;
	return [
		{
			items: [
				{
					title: "Restart all runners",
					sub: "Stops the tasks running on this Mac.",
					control: [
						button(
							"Restart",
							"plain",
							() => void tedixShell.action("restart"),
							now.busy,
						),
					],
					words: "runners supervisor",
				},
				{
					title: "Logs",
					control: [
						button("Show", "plain", () => void tedixShell.action("open-logs")),
					],
					words: "log folder supervisor",
				},
				cli.kind === "included" &&
					cli.canRestore && {
						title: "Use the separate command-line tool",
						sub: "The one installed before this app.",
						control: [button("Use it", "plain", () => act("restore-cli"))],
					},
				...now.status.notes.map((note): Item => ({
					title: "Problem",
					tone: "warn",
					sub: note,
				})),
			].filter(Boolean) as Item[],
		},
	];
}

/** The checks About lists; each is true when fine. */
function checks(now: PanelState): [string, boolean][] {
	const enabled = now.status.runners.filter((runner) => runner.enabled);
	return [
		["Command-line tool", now.setup.cli.kind !== "missing"],
		[
			"Signed in on this Mac",
			now.setup.signedIn && now.setup.app.state === "in",
		],
		["Reaches Tedix", now.setup.reach === "ok"],
		[
			"Runners running",
			now.app.paused ||
				enabled.every((runner) => runner.running) ||
				enabled.length === 0,
		],
	];
}

function about(now: PanelState): Group[] {
	const list = checks(now);
	const ok = list.every(([, fine]) => fine);
	const diagnostics = [
		`Tedix ${now.app.version}`,
		`Command-line tool ${now.setup.cli.version || "not found"} (${now.setup.cli.kind})`,
		now.summary,
		...list.map(([name, fine]) => `${fine ? "ok" : "PROBLEM"}: ${name}`),
		now.setup.reachDetail,
	]
		.filter(Boolean)
		.join("\n");
	return [
		{
			items: [
				{
					title: "Tedix",
					sub: `Version ${now.app.version} · command-line tool ${now.setup.cli.version || "not found"}`,
					control: [
						Object.assign(el("img", "appicon"), {
							src: "assets/icon.png",
							alt: "",
						}),
					],
					words: "version",
				},
			],
		},
		{
			title: "Diagnostics",
			items: [
				{
					title: ok ? "All checks passed" : "Something needs attention",
					tone: ok ? "good" : "warn",
					control: [
						button("Copy", "plain", () => void tedixShell.copy(diagnostics)),
					],
					below: !ok
						? el(
								"div",
								"checks",
								...list.map(([name, fine]) =>
									el(
										"div",
										`state ${fine ? "good" : "warn"}`,
										el("span", "mark"),
										name,
									),
								),
							)
						: undefined,
					words: "diagnostics health",
				},
			],
		},
	];
}

const SECTIONS: Section[] = [
	{ id: "general", name: "General", glyph: "window", groups: general },
	{ id: "tools", name: "Coding tools", glyph: "terminal", groups: tools },
	{ id: "sessions", name: "Sessions", glyph: "bubble", groups: sessions },
	{ id: "mac", name: "This Mac", glyph: "laptop", groups: mac },
	{ id: "updates", name: "Updates", glyph: "download", groups: updates },
	{ id: "advanced", name: "Advanced", glyph: "bolt", groups: advanced },
	{ id: "about", name: "About", glyph: "flag", groups: about },
];

/** A section in the sidebar shows a dot when something there needs the person. */
function needs(now: PanelState, id: SettingsSection): boolean {
	if (id === "tools")
		return foundTools(now).some((tool) => {
			const view = toolView(now, tool);
			return Boolean(view.error) || (view.tone === "warn" && !view.working);
		});
	if (id === "updates")
		return (
			now.setup.cli.kind === "missing" ||
			now.setup.cli.update?.ok === false ||
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
			el("div", "title", item.title),
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
		...SECTIONS.map((entry) => {
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
			return node;
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

search.oninput = () => draw();
document.getElementById("done")!.onclick = () =>
	void tedixShell.action("close-settings");
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

tedixShell.onSection((next) => {
	if (SECTIONS.some((entry) => entry.id === next)) go(next);
});
const receive = (incoming: PanelState) => {
	state = incoming;
	redraw();
};
tedixShell.onState(receive);
void tedixShell.state().then(receive);
