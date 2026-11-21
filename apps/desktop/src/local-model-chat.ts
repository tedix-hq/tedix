import {
	localModelProviders,
	type LocalModelChatApi,
	type LocalModelMessage,
	type LocalModelProvider,
} from "./local-model-client";

declare global {
	interface Window {
		localModelChat: LocalModelChatApi;
	}
}

const api = window.localModelChat;
const provider = document.querySelector<HTMLSelectElement>("#provider")!;
const port = document.querySelector<HTMLInputElement>("#port")!;
const model = document.querySelector<HTMLSelectElement>("#model")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const connection = document.querySelector("#connection")!;
const conversation = document.querySelector("#conversation")!;
const messages = document.querySelector("#messages")!;
const empty = document.querySelector<HTMLElement>("#empty")!;
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const activeModel = document.querySelector("#active-model")!;
const notice = document.querySelector("#notice")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
const stop = document.querySelector<HTMLButtonElement>("#stop")!;
const newChat = document.querySelector<HTMLButtonElement>("#new-chat")!;

const selection = () => {
	const value = provider.value as LocalModelProvider;
	return { provider: value, port: port.valueAsNumber };
};
const history: LocalModelMessage[] = [];
let discovery = 0;
let pending = false;
let busy = false;
let stopped = false;
let replyText: HTMLElement | undefined;

function updateControls() {
	const label = localModelProviders[selection().provider].label;
	activeModel.textContent = model.value ? `${label} · ${model.value}` : "";
	send.disabled = busy || pending || !model.value || !prompt.value.trim();
	provider.disabled = port.disabled = refresh.disabled = busy;
	model.disabled = busy || pending || !model.options.length;
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
	const previous = model.value;
	const server = selection();
	const label = localModelProviders[server.provider].label;
	model.replaceChildren();
	pending = true;
	connection.textContent = `Checking ${label}…`;
	updateControls();
	try {
		const found = await api.models(server);
		if (current !== discovery) return;
		for (const id of found) model.add(new Option(id, id));
		if (found.includes(previous)) model.value = previous;
		connection.textContent = found.length
			? ""
			: `No models available. Add a model to ${label}, then refresh.`;
	} catch (error) {
		if (current === discovery) connection.textContent = messageForError(error);
	} finally {
		if (current === discovery) {
			pending = false;
			updateControls();
		}
	}
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
	const text = prompt.value.trim();
	const server = selection();
	const id = model.value;
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

provider.onchange = () => {
	port.value = String(localModelProviders[selection().provider].port);
	void loadModels();
};
port.onchange = refresh.onclick = () => void loadModels();
model.onchange = prompt.oninput = updateControls;
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

void loadModels();
