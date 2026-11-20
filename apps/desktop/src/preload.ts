import { contextBridge, ipcRenderer } from "electron";
import type { PanelApi } from "./api";

const api: PanelApi = {
	state: () => ipcRenderer.invoke("state"),
	set: (index, key, value) => ipcRenderer.invoke("set", index, key, value),
	action: (name) => ipcRenderer.invoke("action", name),
	openAtLogin: (on) => ipcRenderer.invoke("open-at-login", on),
	onState: (listener) => {
		ipcRenderer.on("state", (_event, state) => listener(state));
	},
};
contextBridge.exposeInMainWorld("tedixShell", api);
