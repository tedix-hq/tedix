import type { PanelApi, PanelState } from "./api";
import { icon, type IconName } from "./icons";
import {
	foundTools,
	keepFocus,
	onButtonsChange,
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
	title: string;
	sub: string;
	control?: Child;
	working?: string;
	failed?: string;
	retry?: () => void;
	cancel?: () => void;
}): HTMLElement {
	if (view.control instanceof HTMLButtonElement)
		view.control.dataset.key = view.key;
	return el(
		"div",
		"r",
		el("span", "glyph", icon(view.icon, 22)),
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
		view.failed &&
			el(
				"div",
				"fail",
				el("span", "", view.failed),
				view.retry && button("Try again", "link", view.retry),
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
	/** Split: the pill and one sentence on the left, rows on the right. */
	label?: string;
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
	const step = STEPS[position(current ?? "welcome") - 1];
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
				if (app.state === "out") act("app-sign-in");
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

	if (id === "mac" || app.state !== "in") {
		const signedIn = app.state === "in";
		const waiting = app.state === "out" && app.waiting;
		return {
			headline: signedIn ? "You’re signed in" : "Sign in to Tedix",
			centre: {
				mark: appIcon(),
				lines: [
					el(
						"p",
						"",
						signedIn
							? "You can connect another app or go straight to Tedix."
							: "Finish signing in in your browser, then return to Tedix.",
					),
					signedIn && button("Connect an app", "link", () => go("tools")),
				],
			},
			primary: signedIn
				? openTedix
				: {
						label: waiting ? "Open browser again" : "Sign in",
						click: () => act("app-sign-in"),
					},
		};
	}

	const rows = foundTools(now)
		.filter((tool) => tool.found === "found")
		.map((tool) => {
			const view = toolView(now, tool, "connection");
			return row({
				key: `tool:${tool.id}`,
				icon: TOOL_ICONS[tool.id] ?? "bubble",
				title: tool.name,
				sub: view.sub,
				control: view.ready ? done("Connected") : view.action,
				working: view.working,
				failed: view.error,
				retry: view.retry,
				cancel: view.cancel,
			});
		});
	if (desktopApps.chatgpt)
		rows.unshift(
			row({
				key: "chat:chatgpt",
				icon: "bubble",
				title: "ChatGPT",
				sub: "Turn on Tedix in Plugins, then start a Work chat.",
				control: button(
					"Open ChatGPT",
					"plain",
					() => void tedixShell.open("chatgpt-app"),
				),
			}),
		);
	if (desktopApps.claude)
		rows.unshift(
			row({
				key: "chat:claude",
				icon: "bubble",
				title: "Claude app",
				sub: "Claude requires a custom connector. Setup is in Settings → Agents.",
			}),
		);
	if (desktopApps.devin)
		rows.push(
			row({
				key: "app:devin",
				icon: "bubble",
				title: "Devin app",
				sub: "Tedix doesn’t have automatic setup for this app yet.",
			}),
		);
	if (
		desktopApps.opencode &&
		!now.setup.tools.some(
			(tool) => tool.id === "opencode" && tool.found === "found",
		)
	)
		rows.push(
			row({
				key: "app:opencode",
				icon: "bubble",
				title: "OpenCode",
				sub: "Could not find OpenCode’s helper. Open OpenCode, then look again.",
				control: button("Look again", "quiet", () => act("check")),
			}),
		);
	return {
		label: "Your apps",
		headline: "Connect an app you use",
		sentence: el(
			"span",
			"",
			"You can connect an app later in Settings. ",
			rows.length > 0 && button("Look again", "link", () => act("check")),
		),
		rows: rows.length
			? rows
			: [
					row({
						key: "no-apps",
						icon: "bubble",
						title: "No supported apps found",
						sub: "Open Tedix to get started.",
						control: button("Look again", "quiet", () => act("check")),
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
