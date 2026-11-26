import type { PanelApi, PanelState } from "./api";
import { icon, type IconName } from "./icons";
import {
	CLAUDE_PLUGIN_SUB,
	claudePluginSteps,
	foundTools,
	keepFocus,
	namedAgentTool,
	onButtonsChange,
	openAgentApp,
	TOOL_APPS,
	TOOL_ICONS,
	toolView,
} from "./ui-parts";

declare const tedixShell: PanelApi;
const screen = document.getElementById("screen")!;
const foot = document.getElementById("foot")!;

const STEPS = [
	["welcome", "Welcome"],
	["mac", "Sign in"],
	["tools", "Connect apps"],
] as const;
type StepId = (typeof STEPS)[number][0];
const position = (id: StepId) => STEPS.findIndex(([step]) => step === id);

let state: PanelState | undefined;
let current: StepId | undefined;
let drawn: StepId | undefined;

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

function row(view: {
	key: string;
	icon: IconName;
	/** The app's own icon, in place of the drawing. */
	image?: string;
	title: string;
	sub: string;
	control?: Child;
	working?: string;
	failed?: string;
	details?: string;
	/** Under the text, across the row: steps with their own buttons. */
	below?: Child;
	retry?: () => void;
	cancel?: () => void;
}): HTMLElement {
	if (view.control instanceof HTMLButtonElement)
		view.control.dataset.key = view.key;
	return el(
		"div",
		"r",
		el(
			"span",
			"glyph",
			view.image
				? Object.assign(el("img", "app-icon"), { src: view.image, alt: "" })
				: icon(view.icon, 22),
		),
		el(
			"div",
			"text",
			el("div", "title", view.title),
			el("div", "sub", view.working ?? view.sub),
		),
		el(
			"div",
			"control",
			view.control,
			view.working &&
				(view.cancel
					? button("Cancel", "quiet", view.cancel)
					: el("span", "spinner")),
		),
		view.below && el("div", "below", view.below),
		view.failed &&
			el(
				"div",
				"fail",
				el("span", "", view.failed),
				view.retry && button("Try again", "link", view.retry),
				view.details &&
					button("Copy details", "link", () => {
						void tedixShell.copy(view.details!);
					}),
			),
	);
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
	/** Split: a headline and one sentence on the left, rows on the right. */
	sentence?: Child;
	rows?: Child[];
	headline: string;
	/** The bottom-right button; Return presses it. */
	/** Absent when the screen offers big choices instead. */
	primary?: { label: string; click: () => void; disabled?: boolean };
}

function go(id: StepId): void {
	current = id;
	draw();
}
const back = () => {
	let at = position(current ?? "welcome") - 1;
	// Signed in, the sign-in step has nothing to do: Back skips it.
	if (STEPS[at]?.[0] === "mac" && state?.setup.app.state === "in") at--;
	const step = STEPS[at];
	if (step) go(step[0]);
};

const appIcon = () =>
	Object.assign(el("img"), { src: "assets/icon.png", alt: "" });

function screenFor(id: StepId, now: PanelState): Screen {
	const { app, desktopApps } = now.setup;
	const openTedix = {
		label: "Open Tedix",
		click: () => void tedixShell.action("close-setup"),
	};

	if (id === "welcome") {
		const signIn = {
			title: "Sign in",
			sub: "Use Tedix with your own account.",
			click: () => {
				go(app.state === "in" ? "tools" : "mac");
				if (app.state !== "in") act("app-sign-in");
			},
		};
		return {
			headline: "Welcome to Tedix",
			centre: {
				mark: appIcon(),
				lines: [],
				choices: now.app.localWorkspace
					? [
							signIn,
							{
								title: "Try a demo",
								sub: "Explore a sample on this Mac without an account.",
								click: () => void tedixShell.action("start-local-workspace"),
							},
						]
					: undefined,
			},
			primary: now.app.localWorkspace
				? undefined
				: { label: signIn.title, click: signIn.click },
		};
	}

	if (app.state !== "in") {
		const waiting = app.state === "out" && app.waiting;
		return {
			headline: "Sign in to Tedix",
			centre: {
				mark: appIcon(),
				lines: [
					el(
						"p",
						"",
						"Finish signing in in your browser, then return to Tedix.",
					),
				],
			},
			primary: {
				label: waiting ? "Open browser again" : "Sign in",
				click: () => act("app-sign-in"),
			},
		};
	}

	const rows = foundTools(now)
		.filter((tool) => tool.found === "found")
		.map((tool) => {
			const named = namedAgentTool(tool);
			const view = toolView(now, named, "connection");
			const appId = TOOL_APPS[named.id];
			return row({
				key: `tool:${named.id}`,
				icon: TOOL_ICONS[named.id] ?? "bubble",
				image: appId && now.setup.appIcons?.[appId],
				title: named.name,
				sub: [named.bothInstalled ? "Connects the desktop app." : "", view.sub]
					.filter(Boolean)
					.join(" "),
				control:
					view.ready ||
					(!view.working && named.connection === "signed-in" && !view.action)
						? el(
								"span",
								"controls",
								view.ready && done("Connected"),
								openAgentApp(now, named),
							)
						: view.action,
				working: view.working,
				failed: view.error,
				details: view.details,
				retry: view.retry,
				cancel: view.cancel,
			});
		});
	if (desktopApps.claude)
		rows.unshift(
			row({
				key: "chat:claude",
				icon: "bubble",
				image: now.setup.appIcons?.claude,
				title: "Claude (Cowork)",
				sub: CLAUDE_PLUGIN_SUB,
				below: claudePluginSteps(),
			}),
		);
	for (const [app, id, name] of [
		["claude", "claude", "Claude Code"],
		["chatgpt", "codex", "ChatGPT"],
		["devin", "devin", "Devin"],
		["opencode", "opencode", "OpenCode"],
	] as const) {
		if (
			!desktopApps[app] ||
			now.setup.tools.some((tool) => tool.id === id && tool.found === "found")
		)
			continue;
		rows.push(
			row({
				key: `app:${app}`,
				icon: "bubble",
				image: now.setup.appIcons?.[app],
				title: name,
				sub:
					app === "claude"
						? "Open the Code tab in Claude once. Tedix finds it when you come back."
						: `Open ${name} and sign in. Tedix finds it when you come back.`,
				control: button(
					`Open ${app === "claude" ? "Claude" : name}`,
					"plain",
					() => void tedixShell.open(`${app}-app`),
				),
			}),
		);
	}
	// Only a real name: the sign-in may give the email address as the name.
	const firstName = app.name.includes("@")
		? ""
		: app.name.trim().split(/\s+/)[0];
	const looking = now.setup.looking;
	return {
		headline: "Add Tedix to your apps",
		sentence: el(
			"span",
			"",
			firstName ? `Welcome, ${firstName}. ` : "",
			"Tedix works inside the apps you already use. You can change this later in Settings.",
			looking &&
				rows.length > 0 &&
				el("span", "looking", el("span", "spinner"), "Looking for apps…"),
		),
		rows: rows.length
			? rows
			: [
					row({
						key: "no-apps",
						icon: "bubble",
						title: looking ? "Looking for apps…" : "No apps found yet",
						sub: looking
							? "This takes a few seconds."
							: "Install Claude or ChatGPT. Tedix finds it when you come back.",
						control: looking && el("span", "spinner"),
					}),
				],
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
	current ??= now.setup.app.state === "in" ? "tools" : "welcome";
	// Back from the browser signed in: straight on to the apps.
	if (current === "mac" && now.setup.app.state === "in") current = "tools";
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
				el("div", "side", headline, el("p", "", view.sentence)),
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
	actions.replaceChildren(...(primary ? [primary] : []));

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
onButtonsChange(() => keepFocus(draw));
tedixShell.onState(receive);
void tedixShell.state().then(receive);
