/* global ui, tedix */
// One thing per screen: a short title, one sentence, the content, one primary
// button. Every action shows working, done or failed with a way to retry.
const style = document.createElement("style");
style.textContent = `
:root,body{background:transparent}
body{margin:0;padding:8px}
.w{display:flex;flex-direction:column;gap:14px;min-height:420px;animation:w-in 180ms ease-out}
@keyframes w-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.w{animation:none}}
.w-dots{display:flex;gap:8px;align-items:center;list-style:none;margin:0;padding:0}
.w-dots li{display:grid;place-items:center;width:22px;height:22px;border-radius:999px;border:1px solid var(--tx-line);color:var(--tx-muted);font-size:12px;line-height:1}
.w-dots li[data-state=current]{border-color:var(--tx-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--tx-accent) 35%,transparent)}
.w h2{font-size:1.6rem;line-height:1.2;margin:6px 0 0;outline:none}
.w-lead{margin:0;font-size:1.05rem;color:var(--tx-muted)}
.w-body{flex:1;display:flex;flex-direction:column;gap:12px}
.w-body p{margin:0}
.w-field{display:flex;flex-direction:column;gap:6px;font-size:.9rem;color:var(--tx-muted)}
.w-field input{min-height:44px;padding:8px 12px;border:1px solid var(--tx-line);border-radius:var(--tx-radius);background:var(--tx-surface);color:var(--tx-fg);font:inherit}
.w-field input:focus-visible{outline:3px solid var(--tx-accent);outline-offset:3px}
.w-list{margin:0;padding-left:1.25rem;display:grid;gap:8px}
.w-state{min-height:48px;margin:0}
.w-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.w-actions .w-space{flex:1}
@media (max-width:480px){.w{min-height:0;gap:12px}.w h2{font-size:1.35rem}.w-actions .tx-primary{order:-1;flex-basis:100%}}
`;
document.head.append(style);

const root = document.getElementById("app");
const STEPS = ["name", "model", "computer"];
let config;
let step = 0;
let busy = false;
let error = "";
let name = "";
let modelRef = "";
// The computer step's own action: idle, working, done, choose or failed.
let computer = { state: "idle", text: "" };
let primary = () => {};

function go(next) {
	step = next;
	error = "";
	render(true);
}

async function save(work) {
	if (busy) return;
	busy = true;
	error = "";
	render();
	try {
		await work();
		busy = false;
		go(step + 1);
	} catch (failure) {
		busy = false;
		error = failure.message || "That did not save. Try again.";
		render();
	}
}

async function setUpComputer(chip) {
	if (busy) return;
	busy = true;
	computer = {
		state: "working",
		text:
			config.computer === "desktop-app"
				? "Opening the setup window…"
				: "Finding the latest version…",
	};
	render();
	try {
		const result = await tedix.call("welcome.computer", { chip: chip ?? null });
		if (result.state === "choose") computer = { state: "choose", text: "" };
		else {
			computer = {
				state: "done",
				text:
					result.state === "opened"
						? "The setup window is open. Follow it, then continue here."
						: `Download started (version ${result.version}). Open the file, move Tedix to Applications and open it. ${config.macFirstOpenNote}`,
			};
		}
	} catch (failure) {
		computer = {
			state: "failed",
			text:
				failure.message ||
				"That did not work. Check your connection and try again.",
		};
	} finally {
		busy = false;
		render();
	}
}

function dots() {
	return ui.el(
		"ol",
		{
			class: "w-dots",
			attrs: {
				"aria-label":
					step < STEPS.length
						? `Step ${step + 1} of ${STEPS.length}`
						: "All steps seen",
			},
		},
		STEPS.map((_, index) =>
			ui.el("li", {
				text: String(index + 1),
				attrs: {
					"data-state": index === step ? "current" : "upcoming",
					"aria-current": index === step ? "step" : null,
				},
			}),
		),
	);
}

function screen({
	title,
	lead,
	body,
	primaryLabel,
	onPrimary,
	skip = true,
	animate,
}) {
	primary = onPrimary;
	const heading = ui.el("h2", { text: title, attrs: { tabindex: -1 } });
	const actions = ui.el("div", { class: "w-actions" });
	if (step > 0)
		actions.append(
			ui.button("Back", () => go(step - 1), {
				variant: "quiet",
				disabled: busy,
			}),
		);
	actions.append(ui.el("span", { class: "w-space" }));
	if (skip)
		actions.append(
			ui.button("Skip for now", () => go(step + 1), {
				variant: "quiet",
				disabled: busy,
			}),
		);
	actions.append(
		ui.button(primaryLabel, onPrimary, { variant: "primary", disabled: busy }),
	);
	const view = ui.el(
		"div",
		{ class: "w" },
		dots(),
		heading,
		ui.el("p", { class: "w-lead", text: lead }),
		ui.el("div", { class: "w-body" }, body),
		error ? ui.alert(error) : null,
		actions,
	);
	if (!animate) view.style.animation = "none";
	root.replaceChildren(view);
	if (animate) heading.focus();
}

function render(animate = false) {
	const id = STEPS[step];
	if (id === "name") {
		const input = ui.el("input", {
			attrs: {
				id: "welcome-name",
				type: "text",
				maxlength: 100,
				autocomplete: "name",
			},
			on: {
				input: (event) => {
					name = event.target.value;
				},
			},
		});
		input.value = name;
		screen({
			title: "What should we call you?",
			lead: `Teammates see this name. You are signed in as ${config.email}.`,
			body: ui.el(
				"label",
				{ class: "w-field", attrs: { for: "welcome-name" } },
				"Your name",
				input,
			),
			primaryLabel: busy ? "Saving…" : error ? "Retry" : "Continue",
			onPrimary: () =>
				save(async () => {
					if (name.trim() && name.trim() !== config.name) {
						await tedix.call("welcome.profile", { name: name.trim() });
						config.name = name.trim();
					}
				}),
			animate,
		});
	} else if (id === "model") {
		const choices = config.models.length > 0;
		screen({
			title: "Pick a model",
			lead: "It answers your questions. You can change it any time beside the chat box.",
			body: choices
				? ui.select({
						label: "Model",
						value: modelRef,
						options: [
							["", "Use the organization default"],
							...config.models.map((model) => [model.ref, model.label]),
							...(config.modelRef &&
							!config.models.some((model) => model.ref === config.modelRef)
								? [[config.modelRef, "Keep current model"]]
								: []),
						],
						onChange: (value) => {
							modelRef = value;
						},
					})
				: ui.el("p", {
						text: config.modelRef
							? "Your saved choice is kept."
							: "Your organization's default is used for now. More choices appear in chat when your organization offers them.",
					}),
			primaryLabel: busy ? "Saving…" : error ? "Retry" : "Continue",
			onPrimary: () =>
				save(async () => {
					if (modelRef !== (config.modelRef || "")) {
						await tedix.call("welcome.model", { ref: modelRef || null });
						config.modelRef = modelRef;
					}
				}),
			skip: choices,
			animate,
		});
	} else if (id === "computer") {
		const kind = config.computer;
		const done = computer.state === "done";
		const body = [];
		if (kind === "other")
			body.push(
				ui.el("p", {
					text: "On this computer, setup is a few commands in a terminal. You find them under Set up this computer in your account menu.",
				}),
			);
		else
			body.push(
				kind === "mac"
					? ui.el("p", { text: "The Tedix app for Mac does it for you:" })
					: null,
				ui.el(
					"ul",
					{ class: "w-list" },
					config.macSetupLines.map((text) => ui.el("li", { text })),
				),
			);
		if (computer.state === "choose")
			body.push(
				ui.el("p", {
					text: "Which Mac is this? Open the Apple menu and choose About This Mac. “Chip: Apple” means Apple silicon.",
				}),
				ui.el(
					"div",
					{ class: "tx-row" },
					ui.button("Apple silicon", () => setUpComputer("appleSilicon"), {
						disabled: busy,
					}),
					ui.button("Intel", () => setUpComputer("intel"), { disabled: busy }),
				),
			);
		else if (computer.state === "failed") body.push(ui.alert(computer.text));
		else
			body.push(
				ui.el("p", {
					class: "w-state",
					text: `${done ? "✓ " : ""}${computer.text}`,
					attrs: { role: "status" },
				}),
			);
		const moveOn = kind === "other" || done || computer.state === "choose";
		screen({
			title:
				kind === "desktop-app" ? "Set up this Mac" : "Set up this computer",
			lead: "Let Tedix work with the coding agents on your computer, such as Claude Code and Codex.",
			body,
			primaryLabel: moveOn
				? "Continue"
				: busy
					? "Working…"
					: computer.state === "failed"
						? "Retry"
						: kind === "desktop-app"
							? "Set up this Mac"
							: "Download the Tedix app for Mac",
			onPrimary: moveOn ? () => go(step + 1) : () => setUpComputer(),
			skip: kind !== "other" && !done,
			animate,
		});
	} else {
		screen({
			title: "Start chatting",
			lead: "Ask Tedix a question or give it a task.",
			body: ui.el("p", {
				class: "tx-muted",
				text: "You can finish setup later from Get started in the sidebar.",
			}),
			primaryLabel: busy
				? "Opening…"
				: error
					? "Retry"
					: "Ask your first question",
			onPrimary: async () => {
				if (busy) return;
				busy = true;
				error = "";
				render();
				try {
					await tedix.call("welcome.complete");
				} catch (failure) {
					busy = false;
					error = failure.message || "That did not save. Try again.";
					render();
				}
			},
			skip: false,
			animate,
		});
	}
}

// Enter activates the primary button, except where Enter already has a job.
document.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.isComposing || busy) return;
	if (event.target.closest?.("button,select,textarea,a")) return;
	event.preventDefault();
	primary();
});

async function load() {
	root.replaceChildren(ui.status("Preparing your welcome…"));
	try {
		config = await tedix.call("welcome.config");
		name = config.name || "";
		modelRef = config.modelRef || "";
		render(true);
	} catch {
		root.replaceChildren(
			ui.alert("Your welcome did not load. Check your connection and retry."),
			ui.button("Retry", load),
		);
	}
}
load();
