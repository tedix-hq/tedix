import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import {
	listLocalModels,
	streamLocalModelReply,
	type LocalModelRequest,
	type LocalModelServer,
} from "./local-model-client";

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

export function openLocalModelChat(): void {
	if (window && !window.isDestroyed()) {
		window.show();
		window.focus();
		return;
	}
	if (!handlersInstalled) {
		handlersInstalled = true;
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

	window = new BrowserWindow({
		title: "Local Model Chat",
		width: 820,
		height: 720,
		minWidth: 440,
		minHeight: 480,
		webPreferences: {
			partition: "tedix-local-model",
			preload: join(__dirname, "local-model-preload.cjs"),
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
	void window.loadFile(join(__dirname, "../local-model.html"));
}
