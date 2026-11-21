import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, session } from "electron";
import {
	localOrigin,
	localPageAllowed,
	localRequestAllowed,
} from "./local-origin";

export function openLocalTedix(): void {
	const executable = app.getPath("exe");
	const args = app.isPackaged ? ["--local"] : [app.getAppPath(), "--local"];
	const mac = process.platform === "darwin";
	// Launch Services registers a separate, foreground Mac app instance.
	const launchArgs = mac
		? ["-na", join(executable, "../../.."), "--args", ...args]
		: args;
	const child = spawn(mac ? "/usr/bin/open" : executable, launchArgs, {
		detached: true,
		stdio: "ignore",
	});
	const showError = () =>
		dialog.showErrorBox(
			"Could not open Local Tedix",
			"Try opening it again from the Tedix menu.",
		);
	child.once("error", showError);
	if (mac)
		child.once("exit", (code) => {
			if (code !== 0) showError();
		});
	child.unref();
}

export function startLocalDesktop(requestedOrigin: string | null): void {
	app.setName("Tedix Local");
	app.setPath("userData", join(app.getPath("appData"), "Tedix Local"));
	if (requestedOrigin === null) {
		dialog.showErrorBox(
			"Invalid local port",
			"Use --local for port 3030, or --local=PORT with a port from 1 to 65535.",
		);
		app.quit();
		return;
	}
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return;
	}

	let origin = requestedOrigin;
	let window: BrowserWindow | undefined;
	const load = () => {
		void window?.loadURL(`${origin}/chat`).catch(() => {});
	};

	app.on("second-instance", (_event, args) => {
		const next = localOrigin(args);
		if (next && next !== origin) {
			origin = next;
			load();
		}
		window?.show();
		window?.focus();
	});
	app.on("activate", () => window?.show());
	app.on("window-all-closed", () => app.quit());
	void app.whenReady().then(() => {
		const localSession = session.defaultSession;
		localSession.webRequest.onBeforeRequest(({ url }, reply) =>
			reply({ cancel: !localRequestAllowed(url) }),
		);

		window = new BrowserWindow({
			title: "Tedix Local",
			width: 1120,
			height: 820,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
			},
		});
		window.on("page-title-updated", (event) => event.preventDefault());
		const contents = window.webContents;
		const inside = (url: string) => localPageAllowed(url, origin);
		const guard = (event: Electron.Event, url: string) => {
			if (!inside(url)) event.preventDefault();
		};
		contents.on("will-navigate", guard);
		contents.on("will-redirect", guard);
		contents.setWindowOpenHandler(({ url }) => {
			if (inside(url)) void contents.loadURL(url).catch(() => {});
			return { action: "deny" };
		});
		contents.on("did-fail-load", (_event, error, _name, url, isMainFrame) => {
			if (!isMainFrame || error === -3 || !inside(url)) return;
			const message = `<!doctype html><meta charset="utf-8"><title>Tedix Local</title>
				<style>
					:root{color-scheme:light dark}
					body{font:16px system-ui;margin:12vh auto 0;max-width:34rem;padding:0 1.5rem;line-height:1.55}
					code{font-size:0.94em}
				</style>
				<h1>Start your local Tedix stack</h1>
				<p>Tedix Local couldn’t reach <code>${origin}</code>.</p>
				<p>From the Tedix source folder, run <code>bun run-local</code>. Use <code>--inference</code> with your Cloudflare account to enable model replies.</p>
				<p><a href="${origin}/chat">Try again</a></p>`;
			void contents
				.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(message)}`)
				.catch(() => {});
		});
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				{
					label: "Tedix Local",
					submenu: [{ role: "about" }, { role: "quit" }],
				},
				{ role: "editMenu" },
				{
					label: "View",
					submenu: [
						{
							label: "Back",
							accelerator: "CmdOrCtrl+[",
							click: () => contents.navigationHistory.goBack(),
						},
						{
							label: "Forward",
							accelerator: "CmdOrCtrl+]",
							click: () => contents.navigationHistory.goForward(),
						},
						{
							label: "Reload",
							accelerator: "CmdOrCtrl+R",
							click: () => {
								if (inside(contents.getURL())) contents.reload();
								else load();
							},
						},
					],
				},
				{ role: "windowMenu" },
			]),
		);
		load();
	});
}
