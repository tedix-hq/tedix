import { type BaseWindow, BrowserWindow, dialog, session } from "electron";
import {
	localOrigin,
	localPageAllowed,
	localRequestAllowed,
} from "./local-origin";

/**
 * Local Tedix opens as a window of this app with its own storage, not as a
 * second copy of the app: a second copy took over the menu bar icon and
 * every launch of Tedix, so Resume Runners and the input bar were out of
 * reach while it ran.
 */
const LOCAL_PARTITION = "persist:tedix-local";
let window: BrowserWindow | undefined;
let origin = "http://localhost:3030";
let guarded = false;

const load = () => {
	void window?.loadURL(`${origin}/chat`).catch(() => {});
};

/** Handles the app menu's Reload command when the Local Tedix window has focus. */
export function reloadLocalTedix(focused: BaseWindow | undefined): boolean {
	if (!window || window !== focused || window.isDestroyed()) return false;
	const contents = window.webContents;
	if (localPageAllowed(contents.getURL(), origin))
		contents.reloadIgnoringCache();
	else load();
	return true;
}

/** Opens or brings forward the Local Tedix window; `args` may carry --local=PORT. */
export function openLocalTedix(args: readonly string[] = []): void {
	const requested = localOrigin(args);
	if (requested === null) {
		dialog.showErrorBox(
			"Invalid local port",
			"Use --local for port 3030, or --local=PORT with a port from 1 to 65535.",
		);
		return;
	}
	const next = requested ?? origin;
	if (window && !window.isDestroyed()) {
		if (next !== origin) {
			origin = next;
			load();
		}
		window.show();
		window.focus();
		return;
	}
	origin = next;
	const localSession = session.fromPartition(LOCAL_PARTITION);
	if (!guarded) {
		guarded = true;
		localSession.webRequest.onBeforeRequest(({ url }, reply) =>
			reply({ cancel: !localRequestAllowed(url) }),
		);
	}
	window = new BrowserWindow({
		title: "Tedix Local",
		width: 1120,
		height: 820,
		webPreferences: {
			session: localSession,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	window.on("page-title-updated", (event) => event.preventDefault());
	window.on("closed", () => {
		window = undefined;
	});
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
	load();
}
