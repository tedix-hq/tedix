import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import {
	listLocalModels,
	localModelProviders,
	streamLocalModelReply,
	type LocalModelPreferences,
	type LocalModelRequest,
	type LocalModelServer,
	validModelPort,
} from "./local-model-client";
import { saveSettings, settings } from "./setup";

let window: BrowserWindow | undefined;
let handlersInstalled = false;
let activeReply: AbortController | undefined;
const availableModels = new Map<string, string[]>();

function fromModelWindow(event: IpcMainInvokeEvent): void {
	if (
		!window ||
		window.isDestroyed() ||
		event.sender !== window.webContents ||
		event.senderFrame !== window.webContents.mainFrame
	)
		throw new Error("Only Local Model Chat can use the model connection.");
}

function modelServerKey(server: LocalModelServer): string {
	return `${server.provider}:${server.port}`;
}

function localPreferences(
	candidate?: LocalModelPreferences,
): LocalModelPreferences {
	const { ports, modelKey } = candidate ?? {};
	return {
		ports: {
			ollama: validModelPort(ports?.ollama)
				? ports.ollama
				: localModelProviders.ollama.port,
			lmstudio: validModelPort(ports?.lmstudio)
				? ports.lmstudio
				: localModelProviders.lmstudio.port,
		},
		modelKey: typeof modelKey === "string" ? modelKey.slice(0, 544) : "",
	};
}

export function openLocalModelChat(): void {
	void app.dock?.show();
	if (window && !window.isDestroyed()) {
		window.show();
		window.focus();
		return;
	}
	if (!handlersInstalled) {
		handlersInstalled = true;
		ipcMain.handle("local-model:preferences", (event) => {
			fromModelWindow(event);
			return localPreferences(settings().localModels);
		});
		ipcMain.handle(
			"local-model:save-preferences",
			(event, preferences: LocalModelPreferences) => {
				fromModelWindow(event);
				saveSettings({ localModels: localPreferences(preferences) });
			},
		);
		ipcMain.handle(
			"local-model:models",
			async (event, server: LocalModelServer) => {
				fromModelWindow(event);
				const models = await listLocalModels(server);
				fromModelWindow(event);
				availableModels.set(modelServerKey(server), models);
				return models;
			},
		);
		ipcMain.handle(
			"local-model:reply",
			async (event, request: LocalModelRequest) => {
				fromModelWindow(event);
				if (activeReply) throw new Error("A reply is already in progress.");
				if (
					!availableModels.get(modelServerKey(request))?.includes(request.model)
				)
					throw new Error("Refresh the model list and choose a model.");
				const controller = new AbortController();
				activeReply = controller;
				try {
					return await streamLocalModelReply(
						request,
						(text) => {
							if (!controller.signal.aborted && !event.sender.isDestroyed())
								event.sender.send("local-model:text", text);
						},
						AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]),
					);
				} finally {
					if (activeReply === controller) activeReply = undefined;
				}
			},
		);
		ipcMain.handle("local-model:stop", (event) => {
			fromModelWindow(event);
			activeReply?.abort();
		});
	}

	const root = app.getAppPath();
	window = new BrowserWindow({
		title: "Chat on This Mac",
		width: 820,
		height: 720,
		minWidth: 440,
		minHeight: 480,
		webPreferences: {
			partition: "tedix-local-model",
			preload: join(root, "out/local-model-preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	const contents = window.webContents;
	contents.on("will-navigate", (event) => event.preventDefault());
	contents.on("will-redirect", (event) => event.preventDefault());
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.on("closed", () => {
		activeReply?.abort();
		activeReply = undefined;
		availableModels.clear();
		window = undefined;
	});
	void window.loadFile(join(root, "local-model.html"));
}
