import { contextBridge, ipcRenderer } from "electron";
import type { PanelApi } from "./api";

const api: PanelApi = {
	state: () => ipcRenderer.invoke("state"),
	set: (index, key, value) => ipcRenderer.invoke("set", index, key, value),
	action: (name) => ipcRenderer.invoke("action", name),
	setup: (action, id) => ipcRenderer.invoke("setup", action, id),
	copy: (text) => ipcRenderer.invoke("copy", text),
	open: (link) => ipcRenderer.invoke("open", link),
	openAtLogin: (on) => ipcRenderer.invoke("open-at-login", on),
	onState: (listener) => {
		ipcRenderer.on("state", (_event, state) => listener(state));
	},
};
contextBridge.exposeInMainWorld("tedixShell", api);
