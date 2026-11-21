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
	applyUpdate: () => ipcRenderer.invoke("update-apply"),
	updateSize: (width, height) =>
		ipcRenderer.invoke("update-size", width, height),
	onUpdate: (listener) => {
		ipcRenderer.on("update", (_event, view) => listener(view));
		ipcRenderer.send("update-ready");
	},
	onDownload: (listener) => {
		ipcRenderer.on("download", (_event, view) => listener(view));
		ipcRenderer.send("download-ready");
	},
	cancelDownload: () => ipcRenderer.invoke("download-cancel"),
};
contextBridge.exposeInMainWorld("tedixShell", api);
