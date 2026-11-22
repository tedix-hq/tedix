import {
	localModelProviders,
	type LocalModelChatApi,
	type LocalModelMessage,
	type LocalModelPreferences,
	type LocalModelProvider,
	type LocalModelServer,
} from "./local-model-client";

declare global {
	interface Window {
		localModelChat: LocalModelChatApi;
	}
}

const api = window.localModelChat;
const model = document.querySelector<HTMLSelectElement>("#model")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const connection = document.querySelector("#connection")!;
const conversation = document.querySelector("#conversation")!;
const messages = document.querySelector("#messages")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const notice = document.querySelector("#notice")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const newChat = document.querySelector<HTMLButtonElement>("#new-chat")!;

const providers = (
	Object.keys(localModelProviders) as LocalModelProvider[]
).map((provider) => ({
	provider,
	label: localModelProviders[provider].label,
	port: document.querySelector<HTMLInputElement>(`#${provider}-port`)!,
	status: document.querySelector(`#${provider}-status`)!,
}));
const choices = new Map<string, LocalModelServer & { id: string }>();
let preferredModel = "";
const history: LocalModelMessage[] = [];
let discovery = 0;
let pending = false;
let busy = false;
let stopped = false;
let replyText: HTMLElement | undefined;

function updateControls() {
	send.disabled =
		busy || pending || !choices.has(model.value) || !prompt.value.trim();
	refresh.disabled = busy || pending;
	for (const entry of providers) entry.port.disabled = busy || pending;
	model.disabled = busy || pending || choices.size === 0;
	newChat.disabled = busy || messages.childElementCount === 0;
	stop.hidden = !busy;
	stop.disabled = stopped;
	empty.hidden = messages.childElementCount > 0;
}

function messageForError(error: unknown) {
	return error instanceof Error
		? error.message.replace(
				/^Error invoking remote method '[^']+': (Error: )?/,
				"",
			)
		: "The local server could not complete the request.";
}

async function loadModels() {
	const current = ++discovery;
	const previous = preferredModel || model.value;
	choices.clear();
	model.replaceChildren(new Option("Finding models…", ""));
	pending = true;
	updateControls();
	for (const entry of providers) entry.status.textContent = "Checking…";
	const results = await Promise.allSettled(
		providers.map((entry) =>
			api.models({ provider: entry.provider, port: entry.port.valueAsNumber }),
		),
	);
	if (current !== discovery) return;
	model.replaceChildren(new Option("Choose a model", ""));
	for (const [index, entry] of providers.entries()) {
		const result = results[index]!;
		if (result.status === "rejected") {
			entry.status.textContent = messageForError(result.reason);
			continue;
		}
		entry.status.textContent = result.value.length
			? "Connected"
			: "Connected. Add a chat model, then refresh.";
		for (const id of result.value) {
			const port = entry.port.valueAsNumber;
			const key = `${entry.provider}:${port}:${id}`;
			choices.set(key, { provider: entry.provider, port, id });
			model.add(new Option(`${entry.label} · ${id}`, key));
		}
	}
	if (choices.has(previous)) model.value = previous;
	else if (!previous && choices.size) model.selectedIndex = 1;
	connection.textContent = !choices.size
		? "Start Ollama or LM Studio with a chat model, then refresh in Connections."
		: previous && !choices.has(previous)
			? "The last model is unavailable. Choose an available model."
			: "";
	pending = false;
	updateControls();
}

function savePreferences() {
	const ports = Object.fromEntries(
		providers.map((entry) => [entry.provider, entry.port.valueAsNumber]),
	) as LocalModelPreferences["ports"];
	void api.savePreferences({ ports, modelKey: preferredModel }).catch(() => {});
}

function addMessage(role: "user" | "assistant", author: string, text = "") {
	const row = document.createElement("article");
	row.className = `turn ${role}`;
	const name = document.createElement("span");
	name.textContent = author;
	const content = document.createElement("div");
	content.textContent = text;
	row.append(name, content);
	messages.append(row);
	return { row, name, content };
}

function scrollToReply() {
	conversation.scrollTop = conversation.scrollHeight;
}

async function sendMessage() {
	if (send.disabled) return;
	const selected = choices.get(model.value);
	if (!selected) return;
	const text = prompt.value.trim();
	const { id, ...server } = selected;
	preferredModel = model.value;
	savePreferences();
	const turn = { role: "user" as const, content: text };
	const user = addMessage("user", "You", text);
	const reply = addMessage("assistant", id);
	replyText = reply.content;
	prompt.value = "";
	busy = true;
	notice.textContent = "Waiting for the model…";
	updateControls();
	scrollToReply();
	try {
		const response = await api.reply({
			...server,
			model: id,
			messages: [...history, turn],
		});
		reply.content.textContent = response;
		history.push(turn, { role: "assistant", content: response });
		notice.textContent = "Reply complete.";
	} catch (error) {
		notice.textContent = stopped ? "Reply stopped." : messageForError(error);
		if (!prompt.value) prompt.value = text;
		if (reply.content.textContent)
			reply.name.textContent = `${id} · Interrupted`;
		else {
			reply.row.remove();
			user.row.remove();
		}
	} finally {
		replyText = undefined;
		busy = stopped = false;
		updateControls();
		prompt.focus();
	}
}

api.onText((text) => {
	if (!replyText) return;
	const nearBottom =
		conversation.scrollHeight -
			conversation.scrollTop -
			conversation.clientHeight <
		60;
	replyText.append(text);
	notice.textContent = "Replying…";
	if (nearBottom) scrollToReply();
});

for (const entry of providers)
	entry.port.onchange = () => {
		savePreferences();
		void loadModels();
	};
refresh.onclick = () => void loadModels();
model.onchange = () => {
	preferredModel = model.value;
	savePreferences();
	updateControls();
};
prompt.oninput = updateControls;
composer.onsubmit = (event) => {
	event.preventDefault();
	void sendMessage();
};
prompt.onkeydown = (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
		event.preventDefault();
		void sendMessage();
	}
};
stop.onclick = () => {
	stopped = true;
	updateControls();
	void api.stop();
};
newChat.onclick = () => {
	history.length = 0;
	messages.replaceChildren();
	notice.textContent = "";
	updateControls();
	prompt.focus();
};

void api
	.preferences()
	.then(
		(preferences) => {
			preferredModel = preferences.modelKey;
			for (const entry of providers)
				entry.port.value = String(preferences.ports[entry.provider]);
		},
		() => {},
	)
	.then(loadModels);
