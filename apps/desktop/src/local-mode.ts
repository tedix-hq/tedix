import { type BaseWindow, BrowserWindow, dialog, session } from "electron";
import {
	bundledLocalAvailable,
	bundledLocalRunning,
	bundledLocalWasStarted,
	startBundledLocal,
} from "./local-service";
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
let bundled = false;
const startLink = "tedix-local://start";
const samplePath = "/workspace/00000000-0000-4000-8000-000000000007";
let setupPage = "";

function openSample() {
	showSetup("starting");
	void startBundledLocal().then(
		() => {
			if (bundled) load();
		},
		() => {
			if (bundled) showSetup("retry");
		},
	);
}

function showSetup(state: "start" | "starting" | "retry" | "unavailable") {
	const title = {
		start: "Try Tedix on this Mac",
		starting: "Opening your sample workspace…",
		retry: "Couldn’t start Tedix on this Mac",
		unavailable: "Local Workspace is unavailable",
	}[state];
	const detail = {
		start:
			"Open a sample workspace with projects and files. It runs on this Mac and needs no account.",
		starting: "This can take a few minutes the first time.",
		retry:
			"Try again. If the workspace still won’t open, quit and reopen Tedix.",
		unavailable:
			"Install a copy of Tedix that includes Local Workspace, or try connecting again.",
	}[state];
	const action =
		state === "starting"
			? ""
			: state === "unavailable"
				? `<a href="${origin}/chat">Try again</a>`
				: `<a href="${startLink}">${state === "retry" ? "Try again" : "Start on this Mac"}</a>`;
	const html = `<!doctype html><meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<title>Tedix Local</title><style>
			:root{color-scheme:light dark}
			body{font:16px system-ui;margin:12vh auto 0;max-width:30rem;padding:0 1.5rem;line-height:1.55}
			h1{font-size:1.8rem;line-height:1.2}
			a{display:inline-block;padding:.65rem 1rem;border-radius:.5rem;background:#3c50c9;color:white;font-weight:600;text-decoration:none}
			a:focus-visible{outline:2px solid currentColor;outline-offset:3px}
		</style><main><h1>${title}</h1><p>${detail}</p>${action}</main>`;
	setupPage = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
	void window?.loadURL(setupPage).catch(() => {});
}

const load = () => {
	if (bundled && !bundledLocalRunning()) {
		showSetup("start");
		return;
	}
	void window
		?.loadURL(`${origin}${bundled ? samplePath : "/chat"}`)
		.catch(() => {});
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
	const useBundle = requested === undefined && bundledLocalAvailable();
	const next = requested ?? "http://localhost:3030";
	const changed = next !== origin || useBundle !== bundled;
	bundled = useBundle;
	if (window && !window.isDestroyed()) {
		if (changed) {
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
	contents.on("will-navigate", (event, url) => {
		if (url === startLink && contents.getURL() === setupPage && bundled) {
			event.preventDefault();
			openSample();
			return;
		}
		guard(event, url);
	});
	contents.on("will-redirect", guard);
	contents.setWindowOpenHandler(({ url }) => {
		if (inside(url)) void contents.loadURL(url).catch(() => {});
		return { action: "deny" };
	});
	contents.on("did-fail-load", (_event, error, _name, url, isMainFrame) => {
		if (!isMainFrame || error === -3 || !inside(url)) return;
		showSetup(bundled ? "retry" : "unavailable");
	});
	if (bundled && !bundledLocalRunning() && bundledLocalWasStarted())
		openSample();
	else load();
}
