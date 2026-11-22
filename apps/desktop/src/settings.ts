import {
	type Appearance,
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
						),
					],
					words: "set up onboarding welcome",
				},
			].filter(Boolean) as Item[],
		},
	];
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
						() => void tedixShell.copy(CONNECTOR_URL),
					),
					button(
						"Open",
						"quiet",
						() => void tedixShell.open("claude-connectors"),
					),
				],
				words: "claude app connector",
			},
			{
				title: "ChatGPT",
				glyph: "bubble-spark",
				sub: "Turn on Tedix in the Plugins Directory.",
				control: [
					button("Open", "plain", () => void tedixShell.open("chatgpt")),
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
	const again = button("Check again", "quiet", () => act("check"));
	if (!found.length && !rows.length)
		return [
			chat,
			{
				title: "Coding tools",
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
		{ title: "Coding tools", column: "Use for tasks", items: rows },
		...(now.setup.routing
			? [
					{
						title: "Who takes which tasks",
						items: [
							...now.setup.routing.sentences.map((sentence): Item => ({
								title: sentence,
								plain: true,
								words: "routing",
							})),
							...(now.setup.routing.file
								? [
										{
											title: "Change these rules",
											control: [
												button(
													"Open the file",
													"plain",
													() => void tedixShell.action("open-routing"),
												),
											],
											words: "routing rules",
										},
									]
								: []),
						],
					},
				]
			: []),
		{
			items: [
				{
					title: "Project folder",
					sub: now.setup.repo.split("/").at(-1) || undefined,
					control: [button("Choose…", "plain", () => act("choose-folder"))],
					words: "repository repo",
				},
				{
					title: "Look for tools again",
					control: [again],
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
									() => void tedixShell.action("restart"),
									now.busy,
								)
							: stopped
								? button(
										"Restart",
										"plain",
										() => void tedixShell.action("restart"),
										now.busy,
									)
								: button(
										"Pause",
										"plain",
										() => void tedixShell.action("pause"),
										now.busy,
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
							() => void tedixShell.action("local-model"),
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
							() => void tedixShell.action("local-workspace"),
						),
					],
					words: "sample offline local workspace",
				},
			],
		},
	];
}

function about(now: PanelState): Group[] {
	const { cli } = now.setup;
	const enabled = now.status.runners.filter((runner) => runner.enabled);
	const failedUpdate = cli.update?.ok === false && !cli.updating;
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
		(now.app.updateFailure || failedUpdate) &&
			"The last update did not finish.",
	].filter((line): line is string => Boolean(line));
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
	const ready = now.app.updateReady || now.app.cliOffer;
	return [
		{
			items: [
				{
					title: "Tedix",
					glyph: undefined,
					sub: cli.updating
						? el("span", "live", el("span", "spinner"), "Updating…")
						: [`Version ${now.app.version}`, now.app.checked]
								.filter(Boolean)
								.join(" · "),
					control: [
						ready
							? button(
									"Update",
									"primary",
									() => void tedixShell.action("apply-update"),
								)
							: button(
									"Check for updates",
									"plain",
									() => void tedixShell.action("check-updates"),
								),
						failedUpdate &&
							cli.other &&
							button(
								"Go back",
								"quiet",
								() => void tedixShell.action("cli-back"),
								now.busy,
							),
					],
					words: "version update",
				},
				{
					title: problems.length ? problems[0]! : "Everything works",
					tone: problems.length ? "warn" : "good",
					sub: problems.length > 1 ? problems.slice(1).join(" ") : undefined,
					control: [
						button(
							"Copy details",
							"quiet",
							() => void tedixShell.copy(details),
						),
					],
					words: "diagnostics health problem",
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
	{ id: "about", name: "About", glyph: "flag", groups: about },
];

/** A section in the sidebar shows a dot when something there needs the person. */
function needs(now: PanelState, id: SettingsSection): boolean {
	if (id === "tools")
		return foundTools(now).some((tool) => {
			const view = toolView(now, tool);
			return Boolean(view.error) || (view.tone === "warn" && !view.working);
		});
	if (id === "about")
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
