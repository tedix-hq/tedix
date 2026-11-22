import { contextBridge, ipcRenderer } from "electron";
import type { LocalModelChatApi } from "./local-model-client";

const api: LocalModelChatApi = {
	preferences: () => ipcRenderer.invoke("local-model:preferences"),
	savePreferences: (preferences) =>
		ipcRenderer.invoke("local-model:save-preferences", preferences),
	models: (server) => ipcRenderer.invoke("local-model:models", server),
	reply: (request) => ipcRenderer.invoke("local-model:reply", request),
	stop: () => ipcRenderer.invoke("local-model:stop"),
	onText: (listener) => {
		ipcRenderer.on("local-model:text", (_event, text: string) =>
			listener(text),
		);
	},
};

contextBridge.exposeInMainWorld("localModelChat", api);
