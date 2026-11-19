/* global ui, tedix */
const root = document.getElementById("app");
let config;
let step = 0;
let busy = false;
let error = "";
let name = "";
let modelRef = "";
const headings = [
	"Your profile",
	"Choose a model",
	"Connect your tools",
	"Start with a question",
];

async function next() {
	if (busy) return;
	busy = true;
	error = "";
	render();
	try {
		if (step === 0 && name.trim() && name.trim() !== config.name) {
			await tedix.call("welcome.profile", { name: name.trim() });
			config.name = name.trim();
		}
		if (step === 1 && modelRef !== (config.modelRef || "")) {
			await tedix.call("welcome.model", { ref: modelRef || null });
			config.modelRef = modelRef;
		}
		if (step === 3) await tedix.call("welcome.complete");
		else step++;
	} catch (failure) {
		error = failure.message || "Could not save. Please try again.";
	} finally {
		busy = false;
		render();
	}
}

function render() {
	const heading = ui.el("h2", {
		text: headings[step],
		attrs: { tabindex: -1 },
	});
	const content = [
		ui.el("p", {
			class: "tx-muted",
			text: `Step ${step + 1} of 4${config.organization ? ` · ${config.organization}` : ""}`,
		}),
		heading,
	];
	if (step === 0) {
		const input = ui.el("input", {
			attrs: {
				id: "welcome-name",
				type: "text",
				maxlength: 100,
				autocomplete: "name",
				class: "tx-button",
			},
			on: {
				input: (event) => {
					name = event.target.value;
				},
			},
		});
		input.value = name;
		content.push(
			ui.el("p", {
				text: `Signed in as ${config.email}. Choose the name teammates see. You can add an avatar later from your account menu under Profile.`,
			}),
			ui.el("label", { text: "Display name", attrs: { for: "welcome-name" } }),
			input,
		);
	} else if (step === 1) {
		content.push(
			ui.el("p", {
				text: "Pick a model for your questions. You can change it from the model button beside the chat box. Your organization decides which models are available.",
			}),
		);
		if (config.models.length)
			content.push(
				ui.select({
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
				}),
			);
		else
			content.push(
				ui.el("p", {
					text: config.modelRef
						? "Your saved model choice is kept. You can change it later in chat."
						: "Use the organization default for now. Available choices appear in chat when your organization offers them.",
				}),
			);
	} else if (step === 2) {
		content.push(
			ui.el("p", {
				text: "Connections let agents work with information in your other tools. Open Apps when you are ready to connect a service, then choose the account and review the access it requests.",
			}),
			ui.el("p", {
				text: "An agent is an AI assistant that can carry out tasks using tools. You control which accounts it can use. Sign-in and consent stay with you; you can start without a connection.",
			}),
		);
	} else {
		content.push(
			ui.el("p", {
				text: "Ask Tedix to research a topic, draft a document, or organize a project. People and agents share tasks, apps, and results in workspaces under your organization's access rules.",
			}),
			ui.el("p", {
				text: "Try: Help me plan this week's priorities. Start with the chat box, use a suggestion, or choose a template from Workspaces. Review results and any approval requests before acting on them.",
			}),
		);
	}
	if (error) content.push(ui.alert(error));
	const actions = ui.el("div", { class: "tx-row" });
	if (step > 0)
		actions.append(
			ui.button(
				"Back",
				() => {
					step--;
					error = "";
					render();
				},
				{ disabled: busy },
			),
		);
	actions.append(
		ui.button(
			busy ? "Saving…" : step === 3 ? "Ask your first question" : "Next",
			next,
			{ variant: "primary", disabled: busy },
		),
	);
	root.replaceChildren(...content, actions);
	heading.focus();
}

async function load() {
	root.replaceChildren(ui.status("Preparing your welcome…"));
	try {
		config = await tedix.call("welcome.config");
		name = config.name || "";
		modelRef = config.modelRef || "";
		render();
	} catch {
		root.replaceChildren(
			ui.alert(
				"Could not load your setup. Try again, or skip the welcome to start a question.",
			),
			ui.button("Try again", load),
		);
	}
}
load();
