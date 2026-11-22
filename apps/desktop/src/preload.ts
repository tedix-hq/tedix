import { contextBridge, ipcRenderer } from "electron";
import type { PanelApi } from "./api";

const api: PanelApi = {
	state: () => ipcRenderer.invoke("state"),
	set: (index, key, value) => ipcRenderer.invoke("set", index, key, value),
	action: (name) => ipcRenderer.invoke("action", name),
	setup: (action, id) => ipcRenderer.invoke("setup", action, id),
	copy: (text) => ipcRenderer.invoke("copy", text),
	open: (link) => ipcRenderer.invoke("open", link),
	openWork: (itemId) => ipcRenderer.invoke("open-work", itemId),
	openAtLogin: (on) => ipcRenderer.invoke("open-at-login", on),
	onState: (listener) => {
		ipcRenderer.on("state", (_event, state) => listener(state));
	},
	applyUpdate: () => ipcRenderer.invoke("update-apply"),
	updateSize: (width, height) =>
		ipcRenderer.invoke("update-size", width, height),
	onUpdate: (listener) => {
		ipcRenderer.on("update", (_event, view) => listener(view));
		ipcRenderer.send("update-ready");
	},
	onQuestion: (listener) => {
		ipcRenderer.on("question", (_event, view) => listener(view));
		ipcRenderer.send("question-ready");
	},
	answerQuestion: (response, checked) =>
		ipcRenderer.invoke("question-answer", response, checked),
	questionSize: (height) => ipcRenderer.invoke("question-size", height),
	newChat: (text) => ipcRenderer.invoke("new-chat", text),
	openLocalChat: () => ipcRenderer.invoke("open-local-chat"),
	closeInputBar: () => ipcRenderer.invoke("input-close"),
};
contextBridge.exposeInMainWorld("tedixShell", api);
