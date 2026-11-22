import type { PanelApi } from "./api";

/**
 * The New Chat launcher. Return sends the Cloud draft; On This Mac opens
 * the local composer without sending or moving that draft.
 */
declare const tedixShell: PanelApi;
const form = document.getElementById("bar") as HTMLFormElement;
const message = document.getElementById("message") as HTMLInputElement;
const send = document.getElementById("send") as HTMLButtonElement;
const local = document.getElementById("local") as HTMLButtonElement;

message.addEventListener("input", () => {
	send.disabled = !message.value.trim();
});
form.addEventListener("submit", (event) => {
	event.preventDefault();
	const text = message.value.trim();
	if (!text) return;
	message.value = "";
	send.disabled = true;
	void tedixShell.newChat(text);
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") void tedixShell.closeInputBar();
});
local.addEventListener("click", () => void tedixShell.openLocalChat());
// The window is reused: each time it opens, the field is ready to type in.
window.addEventListener("focus", () => message.focus());
message.focus();
