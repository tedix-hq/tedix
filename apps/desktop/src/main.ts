import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	type IpcMainInvokeEvent,
	Menu,
	type MenuItemConstructorOptions,
	nativeTheme,
	powerMonitor,
	shell,
	WebContentsView,
} from "electron";
import type {
	PanelAction,
	PanelLink,
	PanelState,
	RunnerField,
	UpdateView,
} from "./api";
import {
	cliProgress,
	goBackCli,
	lookForCliUpdate,
	noteUpdateClick,
	onCliChange,
	restartSupervisor,
	takeUpdateClick,
	updateCli,
} from "./cli";
import { log } from "./log";
import { setRunnerField } from "./runners-file";
import {
	type AppSignIn,
	onSetupChange,
	refreshSetup,
	saveSettings,
	setAppSignIn,
	type SetupAction,
	settings,
	setupAction,
	setupState,
} from "./setup";
import { lastLine, run } from "./shell";
import { loadStatus, type Status, summary } from "./status";
import { checkForUpdate, readyVersion, restartToUpdate } from "./update";

// The copy run from source keeps its own name and data folder and leaves the
// `tedix://` link type to the installed app, so the two never share a session
// or take each other's sign-in links.
if (!app.isPackaged) {
	app.setName("Tedix Dev");
	app.setPath("userData", join(app.getPath("appData"), "Tedix Dev"));
}

/**
 * Tedix OS lives at `os.tedix.dev`, where the sign-in picks the organization,
 * and at `<organization>.os.tedix.dev`. The app opens the one used last.
 */
const isOsHost = (host: string) => /^([a-z0-9-]+\.)?os\.tedix\.dev$/.test(host);
function osOrigin(): string {
	const host = settings().host ?? "";
	return `https://${isOsHost(host) ? host : "os.tedix.dev"}`;
}
const PANEL_LINKS: Record<PanelLink, string> = {
	"claude-connectors": "https://claude.ai/settings/connectors",
	"folder-access":
		"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
};
/** The app folder: this package in dev, the packed app otherwise. */
const root = app.getAppPath();
const RUNNER_FIELDS: RunnerField[] = [
	"enabled",
	"machineName",
	"machineWriteMode",
];
/** The This Mac page gets the preload; the Tedix OS page never does. */
const localPage = {
	preload: join(root, "out/preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
};

let mainWindow: BrowserWindow | undefined;
let os: WebContentsView | undefined;
let panel: BrowserWindow | undefined;
let setupWindow: BrowserWindow | undefined;
let status: Status | undefined;
let lastOutput = "";
let busy = false;
/** A `tedix://` link that arrived before the window existed. */
let startLink: string | undefined;

async function state(): Promise<PanelState> {
	status ??= await loadStatus(powerMonitor.isOnBatteryPower());
	return {
		status,
		setup: setupState(),
		summary: summary(status),
		lastOutput,
		busy,
		openAtLogin: app.isPackaged
			? app.getLoginItemSettings().openAtLogin
			: undefined,
	};
}

async function publish(): Promise<void> {
	const current = await state();
	for (const window of [panel, setupWindow])
		if (window && !window.isDestroyed())
			window.webContents.send("state", current);
	publishUpdate();
}

async function refresh(): Promise<void> {
	status = await loadStatus(powerMonitor.isOnBatteryPower());
	await publish();
}

/** Runs one command and shows its last output line; the app does not act on the result. */
async function command(file: string, args: string[], done: string) {
	busy = true;
	lastOutput = "Running…";
	await publish();
	const result = await run(file, args);
	busy = false;
	lastOutput =
		lastLine(result.output) || (result.ok ? done : "The command failed");
	await refresh();
}

/** The CLI has no restart command, so this restarts the supervisor's login service. */
async function restartRunners(): Promise<void> {
	if (process.platform === "darwin") {
		busy = true;
		lastOutput = "Running…";
		await publish();
		const result = await restartSupervisor();
		busy = false;
		lastOutput = result.ok
			? "Runners restarted"
			: lastLine(result.output) || "The background service did not start";
		return refresh();
	}
	lastOutput = "Restart `tedix supervise` yourself on this system";
	await publish();
}

/**
 * The update button: a small view of the app's own over the top-right corner
 * of the main window. It is there only while something can be applied: a
 * newer app that is downloaded and checked, or a newer command-line tool
 * than the app's copy in use. It is the only thing that applies either.
 */
let updateButton: WebContentsView | undefined;
/** How much room the button's page asked for. */
let updateSize = { width: 0, height: 0 };
let applying: string | undefined;
let failure: string | undefined;
let doneLine: string | undefined;
let pageDark = nativeTheme.shouldUseDarkColors;
let layoutMain = () => {};

/** A newer command-line tool, when `~/.local/bin/tedix` is the app's copy. */
function cliOffer(): string | undefined {
	const { kind, offer } = setupState().cli;
	return kind === "included" ? offer : undefined;
}

function updateView(): UpdateView {
	const dark = pageDark;
	if (applying) {
		const step = cliProgress().updating ?? "";
		const text = step.startsWith("Downloading")
			? "Downloading…"
			: /^(Restarting|Waiting)/.test(step)
				? "Restarting runners…"
				: applying;
		return { kind: "working", text, dark };
	}
	if (failure) return { kind: "failed", text: failure, dark };
	if (doneLine) return { kind: "done", text: doneLine, dark };
	const kind = readyVersion() || cliOffer() ? "available" : "hidden";
	return { kind, text: "", dark };
}

/**
 * The Tedix OS page keeps its top bars clear of the button: the app adds
 * the room on the right while the button is there.
 */
let reserved = 0;
let reservedRule: Promise<string> | undefined;
function reserve(pixels: number, again = false): void {
	const contents = os?.webContents;
	if (!contents || contents.isDestroyed()) return;
	if (pixels === reserved && !again) return;
	reserved = pixels;
	const old = again ? undefined : reservedRule;
	reservedRule = pixels
		? contents.insertCSS(
				`.topbar, .canvas-workspace-header { padding-right: ${pixels}px !important; }`,
			)
		: undefined;
	void old?.then((rule) => contents.removeInsertedCSS(rule)).catch(() => {});
}

function publishUpdate(): void {
	const contents = updateButton?.webContents;
	if (contents && !contents.isDestroyed())
		contents.send("update", updateView());
	layoutMain();
}

/** Says what is in use now, briefly, where the button was. */
function sayDone(line: string): void {
	doneLine = line;
	log(`update: ${line}`);
	setTimeout(() => {
		if (doneLine === line) doneLine = undefined;
		publishUpdate();
	}, 15_000);
}

/**
 * Puts the newest command-line tool in place and reloads the background
 * service. Only ever reached from the person's click on the update button:
 * directly, or on the start that follows it (see `takeUpdateClick`).
 */
async function applyCommandLineTool(appUpdated: boolean): Promise<void> {
	const from = Date.now();
	if (cliOffer()) {
		await updateCli();
		await refreshSetup(false);
		const last = cliProgress().last;
		if (last && !last.ok) throw new Error(last.text);
	}
	const { version } = setupState().cli;
	const parts = [
		appUpdated && `Tedix ${app.getVersion()}`,
		version && `command-line tool ${version}`,
	].filter((part): part is string => Boolean(part));
	if (!parts.length) return;
	const names = parts.join(" and ");
	sayDone(
		`${names[0]!.toUpperCase()}${names.slice(1)} ${parts.length > 1 ? "are" : "is"} in use.${
			cliProgress().reloadedAt >= from
				? " Runners restarted. If macOS asks whether Tedix may access your Documents folder, choose Allow."
				: ""
		}`,
	);
}

/** Runs one of the button's jobs and shows how it ended. */
async function working(text: string, job: () => Promise<void>): Promise<void> {
	if (applying) return;
	applying = text;
	failure = undefined;
	doneLine = undefined;
	publishUpdate();
	try {
		await job();
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
		log(`update: did not finish (${failure})`);
	}
	applying = undefined;
	await refresh();
}

/**
 * The click on the update button, or on its Retry. With a newer app ready
 * (or once its download finishes) it restarts into it, and the note it
 * leaves lets that start put the newest command-line tool in place. With
 * only a newer command-line tool it does that now, without a restart.
 */
function applyUpdate(): Promise<void> {
	return working("Downloading…", async () => {
		if (cliProgress().last?.down) {
			// Retry after a reload that left the runners down: reload again.
			applying = "Restarting runners…";
			publishUpdate();
			const result = await restartSupervisor();
			if (!result.ok)
				throw new Error(
					`The background service did not start: ${lastLine(result.output) || "no reason given"}.`,
				);
			return sayDone("Runners restarted.");
		}
		try {
			await checkForUpdate();
		} catch (error) {
			log(`update: check failed (${(error as Error).message})`);
		}
		applying = "Updating…";
		publishUpdate();
		if (readyVersion()) {
			noteUpdateClick();
			restartToUpdate();
			// The app quits now; the button keeps working until it does.
			return new Promise(() => {});
		}
		await applyCommandLineTool(false);
	});
}

function isTedixPage(url: string): boolean {
	const target = URL.parse(url);
	return (
		target?.protocol === "https:" &&
		(target.hostname === "tedix.dev" || target.hostname.endsWith(".tedix.dev"))
	);
}

/** Sign-in pages that refuse to work inside an app window. */
function refusesAppWindows(url: string): boolean {
	const host = URL.parse(url)?.hostname;
	return host === "accounts.google.com" || host === "appleid.apple.com";
}

/** Tells the person what happened; `detail` says what to do next. */
async function tell(message: string, detail: string, buttons = ["OK"]) {
	await app.whenReady();
	const options = {
		type: "info" as const,
		message,
		detail,
		buttons,
		defaultId: 0,
		cancelId: buttons.length - 1,
	};
	const window = mainWindow?.isDestroyed() ? undefined : mainWindow;
	const { response } = window
		? await dialog.showMessageBox(window, options)
		: await dialog.showMessageBox(options);
	return response;
}

/**
 * The browser sign-in in progress: the key pair made for it. It is kept in a
 * file in the app's own data folder, next to the session it leads to, so
 * quitting the app between the two steps does not lose it.
 */
interface BrowserSignIn {
	privateKey: JsonWebKey;
	publicKey: string;
	expires: number;
	/** The Tedix OS address the browser signs in at; the finish page loads there too. */
	origin?: string;
}
const SIGN_IN_WAIT_MS = 30 * 60_000;
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const browserSignInFile = () =>
	join(app.getPath("userData"), "browser-sign-in.json");

function pendingBrowserSignIn(): BrowserSignIn | undefined {
	let pending: BrowserSignIn;
	try {
		pending = JSON.parse(
			readFileSync(browserSignInFile(), "utf8"),
		) as BrowserSignIn;
	} catch {
		return undefined;
	}
	if (pending.expires > Date.now()) return pending;
	rmSync(browserSignInFile(), { force: true });
	log("sign-in: nobody finished the browser sign-in in 30 minutes");
	return undefined;
}

/**
 * Who is signed in to Tedix in this app's window. The Tedix OS page asks its
 * own server and hands back the name and email; the app never sees the
 * session itself. An answer that is neither yes nor no keeps the last one.
 */
let appSignIn: AppSignIn = {
	state: "unknown",
	name: "",
	email: "",
	waiting: false,
};
async function readAppSignIn(): Promise<void> {
	const view = os;
	if (!view || view.webContents.isDestroyed()) return;
	const next = { ...appSignIn };
	try {
		// Only a Tedix OS page can ask; on any other page the last answer stays.
		if (!isOsHost(URL.parse(view.webContents.getURL())?.host ?? ""))
			throw new Error("not on Tedix OS");
		const answer = (await view.webContents.executeJavaScript(
			`fetch("/auth/session-broker/status", { cache: "no-store" }).then(
				async (response) => ({ status: response.status, ...(await response.json()) }),
			)`,
		)) as {
			status: number;
			authenticated?: boolean;
			renewalRequired?: boolean;
			user?: { name?: string; email?: string };
		};
		if (answer.authenticated === true) {
			next.state = "in";
			next.email = String(answer.user?.email ?? "");
			next.name = String(answer.user?.name ?? "");
		} else if (!answer.renewalRequired && answer.status < 500)
			next.state = "out";
	} catch {
		/* Offline or Tedix OS did not answer: keep what was known. */
	}
	if (next.state === "in" && pendingBrowserSignIn()) {
		// Signed in another way while the browser sign-in was still waiting.
		rmSync(browserSignInFile(), { force: true });
	}
	next.waiting = next.state !== "in" && Boolean(pendingBrowserSignIn());
	if (next.state !== appSignIn.state)
		log(
			`sign-in: ${next.state === "in" ? "signed in to Tedix in this app" : next.state === "out" ? "not signed in to Tedix in this app" : "could not tell"}`,
		);
	const menuChanged =
		next.state !== appSignIn.state || next.name !== appSignIn.name;
	appSignIn = next;
	setAppSignIn(next);
	if (menuChanged) setMenu();
}

/**
 * Google and Apple refuse to sign people in inside an app window, so this
 * opens Tedix OS in the person's normal browser. The browser gets a public
 * key made here; the code it sends back (`tedix://sign-in?code=…`) is sealed
 * to that key, so only this app can read it. Choosing this again while a
 * sign-in is waiting reuses its key, so every open browser tab still works.
 */
async function signInWithBrowser(): Promise<void> {
	let pending = pendingBrowserSignIn();
	log(`sign-in: opening the browser (${pending ? "same" : "new"} request)`);
	if (!pending) {
		const pair = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
		pending = {
			privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
			publicKey: Buffer.from(
				await crypto.subtle.exportKey("raw", pair.publicKey),
			).toString("base64url"),
			expires: 0,
		};
	}
	// The address the view is on now, so the session is made where it is used.
	const viewing = URL.parse(os?.webContents.getURL() ?? "");
	pending.origin =
		viewing && isOsHost(viewing.host) ? viewing.origin : osOrigin();
	pending.expires = Date.now() + SIGN_IN_WAIT_MS;
	writeFileSync(browserSignInFile(), JSON.stringify(pending), { mode: 0o600 });
	const page = new URL("/auth/desktop/sign-in", pending.origin);
	page.searchParams.set("key", pending.publicKey);
	await shell.openExternal(page.href);
	void readAppSignIn();
}

/** Says why the sign-in did not finish and offers to start it again. */
async function signInFailed(reason: string, what: string): Promise<void> {
	log(`sign-in: failed (${reason})`);
	const again = await tell(
		"Sign-in did not finish",
		`${what} Choose Sign In with Browser again.`,
		["Sign In with Browser", "Cancel"],
	);
	if (again === 0) await signInWithBrowser();
}

/**
 * Opens the code with the steps of `openDesktopSignInCode` in
 * `packages/auth/src/desktop-sign-in-code.ts`. Throws when the code was made
 * for another request.
 */
async function openSignInCode(
	privateKey: JsonWebKey,
	code: string,
): Promise<string> {
	const bytes = Buffer.from(code, "base64url");
	if (bytes.length < 78) throw new Error("Too short");
	const sender = await crypto.subtle.importKey(
		"raw",
		bytes.subarray(0, 65),
		ECDH,
		false,
		[],
	);
	const shared = await crypto.subtle.importKey(
		"raw",
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: sender },
			await crypto.subtle.importKey("jwk", privateKey, ECDH, false, [
				"deriveBits",
			]),
			256,
		),
		"HKDF",
		false,
		["deriveKey"],
	);
	const key = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new Uint8Array(32),
			info: new TextEncoder().encode("tedix-desktop-sign-in"),
		},
		shared,
		{ name: "AES-GCM", length: 256 },
		false,
		["decrypt"],
	);
	return new TextDecoder().decode(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes.subarray(65, 77) },
			key,
			bytes.subarray(77),
		),
	);
}

/**
 * Finishes a sign-in started with the browser: opens the code and loads the
 * one-time sign-in token it holds in the Tedix OS view. Every way this can
 * fail tells the person and is logged.
 */
async function finishBrowserSignIn(code: string): Promise<void> {
	const view = os;
	if (!view) return;
	const pending = pendingBrowserSignIn();
	if (!pending)
		return signInFailed(
			"no request waiting",
			"This app was not waiting for a sign-in, or it waited longer than 30 minutes.",
		);
	let token: string;
	try {
		token = await openSignInCode(pending.privateKey, code);
	} catch {
		return signInFailed(
			"code is for another request",
			"The browser page belonged to an earlier sign-in or to another copy of the app.",
		);
	}
	rmSync(browserSignInFile(), { force: true });
	log("sign-in: code opened, loading the finish page");
	// The page signs in a moment after it loads.
	setTimeout(() => void readAppSignIn(), 4000);
	const finish = new URL("/login", pending.origin ?? osOrigin());
	// The changing value makes this a full page load even when the view is
	// already on `/login`; a change of only the part after `#` loads nothing.
	finish.searchParams.set("attempt", String(Date.now()));
	finish.hash = new URLSearchParams({ "desktop-sign-in": token }).toString();
	try {
		await view.webContents.loadURL(finish.href);
	} catch (error) {
		// The page moving on before it finished loading is the sign-in working.
		if ((error as { code?: string }).code === "ERR_ABORTED") return;
		return signInFailed(
			"finish page did not load",
			"Tedix OS could not be reached. Check your connection.",
		);
	}
}

/**
 * `tedix://sign-in?link=<emailed link>`: the Tedix OS sign-in page sends this
 * from the browser so the emailed link finishes in this window instead.
 * `tedix://sign-in?code=<code>` finishes a sign-in started with the browser.
 * `tedix://setup` opens the Set up this Mac window.
 */
function openAppLink(value: string | undefined): void {
	const target = URL.parse(value ?? "");
	if (
		target?.protocol !== "tedix:" ||
		(target.host !== "sign-in" && target.host !== "setup")
	)
		return;
	if (!os) {
		startLink = value;
		return;
	}
	mainWindow?.show();
	mainWindow?.focus();
	// `tedix://setup`: the Tedix OS page's "Set up this Mac" button.
	if (target.host === "setup") {
		log("link: setup window asked for");
		return openSetup();
	}
	const code = target.searchParams.get("code");
	if (code) {
		log("link: sign-in code received");
		void finishBrowserSignIn(code);
		return;
	}
	const link = target.searchParams.get("link") ?? "";
	if (!isTedixPage(link)) return log("link: ignored, not a Tedix sign-in link");
	log("link: emailed sign-in link received");
	finishSignIn(link);
}

/**
 * Opens a sign-in link in a hidden window that shares the main view's
 * session, so the page that asked for the link stays open and continues by
 * itself. Loading the link in the main view replaces that page and ends on
 * "you can close this window". If the main view is still on the sign-in page
 * afterwards, it reloads Tedix OS with the session the link created.
 */
function finishSignIn(link: string): void {
	const view = os;
	if (!view) return;
	const helper = new BrowserWindow({
		show: false,
		webPreferences: {
			partition: "persist:tedix-os",
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	helper.webContents.setUserAgent(view.webContents.getUserAgent());
	void helper.loadURL(link);
	setTimeout(() => {
		if (!helper.isDestroyed()) helper.destroy();
		if (view.webContents.isDestroyed()) return;
		if (URL.parse(view.webContents.getURL())?.pathname === "/login")
			void view.webContents.loadURL(`${osOrigin()}/chat`);
	}, 8000);
}

/**
 * The main window: the Tedix OS chat fills it, with the macOS window buttons
 * over the page's top-left corner. The page leaves room for them and marks
 * its top bars as the areas that drag the window. The Tedix OS page gets no
 * access to this app or the computer; its sign-in lives in a session kept
 * between launches.
 */
function createMainWindow(): void {
	const window = new BrowserWindow({
		width: 1280,
		height: 860,
		title: "Tedix",
		titleBarStyle: "hiddenInset",
		// Centres the buttons in the page's 56 px top bar.
		trafficLightPosition: { x: 20, y: 20 },
		backgroundColor: "#0a0a0a",
	});
	mainWindow = window;

	const view = new WebContentsView({
		webPreferences: {
			partition: "persist:tedix-os",
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	os = view;
	window.contentView.addChildView(view);
	// The update button, over the right end of the page's 56 px top bar. The
	// line that says what happened shows below the bar instead.
	const button = new WebContentsView({ webPreferences: localPage });
	updateButton = button;
	button.setBackgroundColor("#00000000");
	button.setVisible(false);
	button.webContents.on("will-navigate", (event) => event.preventDefault());
	button.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.contentView.addChildView(button);
	void button.webContents.loadFile(join(root, "update.html"));
	const layout = () => {
		if (window.isDestroyed()) return;
		const { width, height } = window.getContentBounds();
		view.setBounds({ x: 0, y: 0, width, height });
		const { kind } = updateView();
		const size = kind === "hidden" ? { width: 0, height: 0 } : updateSize;
		button.setVisible(size.width > 0);
		button.setBounds({
			x: width - 12 - size.width,
			y: kind === "done" ? 64 : 12,
			...size,
		});
		// The reason under a failed button may cover the bar; it is open on a click.
		reserve(
			kind === "available" || kind === "failed"
				? 56
				: kind === "working" && size.width
					? size.width + 24
					: 0,
		);
	};
	layoutMain = layout;
	layout();
	window.on("resize", layout);

	// A link that asks for a new window: Tedix pages load here, anything else
	// opens in the default browser. Redirects inside the page are left alone
	// so sign-in can leave and come back.
	view.webContents.setWindowOpenHandler(({ url }) => {
		if (refusesAppWindows(url)) void signInWithBrowser();
		else if (isTedixPage(url)) void view.webContents.loadURL(url);
		else if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	// The window takes the page's own background colour, so resizing and
	// loading do not flash another colour in light or dark.
	view.webContents.on("did-finish-load", () => {
		void view.webContents
			.executeJavaScript("getComputedStyle(document.body).backgroundColor")
			.then((colour: unknown) => {
				const rgb = String(colour).match(/\d+/g)?.slice(0, 3).map(Number);
				if (rgb?.length !== 3 || window.isDestroyed()) return;
				window.setBackgroundColor(
					`#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
				);
				pageDark = rgb[0]! + rgb[1]! + rgb[2]! < 384;
				publishUpdate();
			})
			.catch(() => {});
	});
	// Google and Apple block sign-in inside an app window: continue in the
	// person's normal browser instead of showing their refusal page.
	const leaveForBrowser = (event: Electron.Event, url: string) => {
		if (!refusesAppWindows(url)) return;
		event.preventDefault();
		void signInWithBrowser();
	};
	view.webContents.on("will-navigate", leaveForBrowser);
	view.webContents.on("will-redirect", leaveForBrowser);
	// Page addresses without anything after `?` or `#`, to trace a sign-in.
	view.webContents.on("did-navigate", (_event, url, status) => {
		const page = URL.parse(url);
		log(`page: ${page?.host}${page?.pathname} (${status})`);
		// A new page has lost the room made for the update button.
		reserve(reserved, true);
		// Remembered so the next launch opens the same organization.
		if (page?.protocol === "https:" && isOsHost(page.host) && status < 400)
			if (settings().host !== page.host) saveSettings({ host: page.host });
		void readAppSignIn();
	});
	// The added name lets the sign-in page tell this app from a browser.
	view.webContents.setUserAgent(
		`${view.webContents.getUserAgent()} TedixDesktop/${app.getVersion()}`,
	);
	void view.webContents.loadURL(`${osOrigin()}/chat`);
	view.webContents.focus();
}

/** The background of the app's own two windows, so they do not flash while loading. */
const windowColour = () =>
	nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#fafafa";

/** The small This Mac window: status and the day-to-day switches. */
function openPanel(): void {
	if (panel && !panel.isDestroyed()) return panel.show();
	panel = new BrowserWindow({
		width: 400,
		height: 640,
		title: "This Mac",
		backgroundColor: windowColour(),
		parent: mainWindow,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		webPreferences: localPage,
	});
	panel.setMenuBarVisibility(false);
	panel.webContents.on("will-navigate", (event) => event.preventDefault());
	panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	void panel.loadFile(join(root, "panel.html"));
	void refresh();
}

/**
 * The Set up this Mac window: one step per screen. It opens by itself while
 * the sign-in on this Mac is still to do, from the menu, and from a
 * `tedix://setup` link.
 */
function openSetup(): void {
	if (setupWindow && !setupWindow.isDestroyed()) return setupWindow.show();
	const window = new BrowserWindow({
		width: 840,
		height: 620,
		title: "Set up this Mac",
		parent: mainWindow,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		titleBarStyle: "hiddenInset",
		backgroundColor: windowColour(),
		webPreferences: localPage,
	});
	setupWindow = window;
	window.setMenuBarVisibility(false);
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// Coming back from the browser shows the new state at once.
	window.on("focus", () => {
		void refreshSetup(false);
		void readAppSignIn();
	});
	void window.loadFile(join(root, "setup.html"));
	void refresh();
	void refreshSetup(true);
}

function fromLocalPage(event: IpcMainInvokeEvent): BrowserWindow {
	const window = [panel, setupWindow].find(
		(candidate) =>
			candidate &&
			!candidate.isDestroyed() &&
			event.sender === candidate.webContents,
	);
	if (!window) throw new Error("Not allowed");
	return window;
}

function navigate(action: "back" | "forward" | "reload"): void {
	const contents = os?.webContents;
	if (action === "back") contents?.navigationHistory.goBack();
	else if (action === "forward") contents?.navigationHistory.goForward();
	else contents?.reload();
}

/**
 * Looks for a newer app and a newer command-line tool. It downloads and
 * checks a newer app and reads which command-line tool is published; it
 * applies nothing. What it finds makes the update button appear. `asked` is
 * true when the person chose Check for Updates…: then it also answers when
 * there is nothing to apply.
 */
async function checkForUpdates(asked: boolean): Promise<void> {
	let problem = "";
	try {
		const result = await checkForUpdate();
		if (result.kind === "unavailable") problem = result.reason;
	} catch (error) {
		problem = `Could not check for a newer app: ${error instanceof Error ? error.message : String(error)}. Try again later.`;
		log(`update: ${problem}`);
	}
	await lookForCliUpdate(asked);
	await refreshSetup(false);
	publishUpdate();
	if (!asked) return;
	if (updateView().kind !== "hidden") return mainWindow?.show();
	const { version } = setupState().cli;
	await tell(
		"Everything is up to date",
		[
			`You have Tedix ${app.getVersion()}${version ? ` and command-line tool ${version}` : ""}.`,
			problem,
		]
			.filter(Boolean)
			.join(" "),
	);
}

function setMenu(): void {
	const thisMac: MenuItemConstructorOptions = {
		label: "This Mac…",
		accelerator: "CmdOrCtrl+Shift+M",
		click: openPanel,
	};
	const setUp: MenuItemConstructorOptions = {
		label: "Set Up This Mac…",
		click: openSetup,
	};
	const mac = process.platform === "darwin";
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: mac ? app.name : "Tedix",
				submenu: [
					...(mac ? [{ role: "about" as const }] : []),
					thisMac,
					setUp,
					// Offered only while it is needed: signing in again when already
					// signed in opens a browser page that leads nowhere.
					appSignIn.state === "in"
						? {
								label: `Signed In as ${appSignIn.name || appSignIn.email || "you"}`,
								enabled: false,
							}
						: {
								label: "Sign In with Browser",
								click: () => {
									log("sign-in: chosen from the menu");
									void signInWithBrowser();
								},
							},
					{
						label: "Check for Updates…",
						click: () => void checkForUpdates(true),
					},
					{ type: "separator" },
					...(mac ? [{ role: "hide" as const }] : []),
					{ role: "quit" },
				],
			},
			{ role: "editMenu" },
			{
				label: "View",
				submenu: [
					{
						label: "Back",
						accelerator: "CmdOrCtrl+[",
						click: () => navigate("back"),
					},
					{
						label: "Forward",
						accelerator: "CmdOrCtrl+]",
						click: () => navigate("forward"),
					},
					{
						label: "Reload",
						accelerator: "CmdOrCtrl+R",
						click: () => navigate("reload"),
					},
				],
			},
			{ role: "windowMenu" },
		]),
	);
}

const appLink = (args: string[]) =>
	args.find((arg) => arg.startsWith("tedix://"));

if (!app.requestSingleInstanceLock()) app.quit();
else {
	if (app.isPackaged) app.setAsDefaultProtocolClient("tedix");
	// macOS hands a clicked link over here; other systems pass it as an argument.
	app.on("open-url", (event, url) => {
		event.preventDefault();
		openAppLink(url);
	});
	openAppLink(appLink(process.argv));
	void app.whenReady().then(() => {
		log(`start: version ${app.getVersion()}`);
		// Read and deleted before anything else: only a start that follows a
		// click on the update button may replace the command-line tool.
		const clicked = takeUpdateClick();
		setMenu();
		createMainWindow();
		openAppLink(startLink);

		ipcMain.handle("state", (event) => {
			fromLocalPage(event);
			return state();
		});
		ipcMain.handle(
			"set",
			async (event, index: number, key: RunnerField, value: unknown) => {
				fromLocalPage(event);
				if (!Number.isInteger(index) || !RUNNER_FIELDS.includes(key)) return;
				if (
					value !== undefined &&
					typeof value !== "string" &&
					typeof value !== "boolean"
				)
					return;
				try {
					setRunnerField(index, key, value);
				} catch (error) {
					lastOutput = error instanceof Error ? error.message : String(error);
					return refresh();
				}
				await restartRunners();
			},
		);
		ipcMain.handle("action", (event, name: PanelAction) => {
			fromLocalPage(event);
			if (name === "restart") return restartRunners();
			if (name === "cli-back") return void goBackCli();
			if (name === "setup-window") return openSetup();
			if (name === "close-setup" || name === "done-setup") {
				setupWindow?.close();
				if (name === "done-setup") return;
				mainWindow?.show();
				mainWindow?.focus();
			}
		});
		ipcMain.handle("setup", async (event, action: SetupAction, id: unknown) => {
			const asking = fromLocalPage(event);
			await setupAction(action, typeof id === "string" ? id : "", {
				chooseFolder: async () => {
					const options = {
						message: "Choose the project folder Tedix should work in",
						properties: ["openDirectory" as const],
					};
					const chosen = await dialog.showOpenDialog(asking, options);
					return chosen.canceled ? undefined : chosen.filePaths[0];
				},
				appSignIn: () => {
					log("sign-in: chosen in Set up this Mac");
					return signInWithBrowser();
				},
			});
			await refresh();
		});
		ipcMain.handle("copy", (event, text: unknown) => {
			fromLocalPage(event);
			if (typeof text === "string") clipboard.writeText(text.slice(0, 20_000));
		});
		ipcMain.handle("open", (event, link: PanelLink) => {
			fromLocalPage(event);
			const url = PANEL_LINKS[link];
			if (url) return shell.openExternal(url);
		});
		// Only the update button's own page may ask for an update.
		const fromUpdateButton = (event: { sender: Electron.WebContents }) =>
			event.sender === updateButton?.webContents;
		ipcMain.handle("update-apply", (event) => {
			if (!fromUpdateButton(event)) throw new Error("Not allowed");
			void applyUpdate();
		});
		ipcMain.handle("update-size", (event, width: unknown, height: unknown) => {
			if (!fromUpdateButton(event)) throw new Error("Not allowed");
			updateSize = {
				width: Math.max(0, Math.min(Number(width) || 0, 440)),
				height: Math.max(0, Math.min(Number(height) || 0, 320)),
			};
			layoutMain();
		});
		ipcMain.on("update-ready", (event) => {
			if (fromUpdateButton(event)) publishUpdate();
		});
		ipcMain.handle("open-at-login", (event, on: boolean) => {
			fromLocalPage(event);
			app.setLoginItemSettings({ openAtLogin: on === true });
			return publish();
		});

		app.on("second-instance", (_event, args) => {
			mainWindow?.show();
			openAppLink(appLink(args));
		});
		// Closing the window quits the app; the supervisor keeps the runners running.
		app.on("window-all-closed", () => app.quit());
		powerMonitor.on("on-battery", () => void refresh());
		powerMonitor.on("on-ac", () => void refresh());
		setInterval(() => {
			void refresh();
			// While a browser sign-in is waiting, notice when it ends.
			if (appSignIn.waiting) void readAppSignIn();
		}, 5000);
		// The checklist opens by itself while the command-line tool or the
		// sign-in on this Mac is still to do.
		onSetupChange(() => void publish());
		onCliChange(() => void refreshSetup(false).then(refresh));
		void refreshSetup(true).then(() => {
			if (setupState().open) openSetup();
			// The second half of the click that restarted the app.
			if (clicked) {
				log("update: this start follows a click on the update button");
				void working("Updating…", async () => {
					await lookForCliUpdate(false);
					await refreshSetup(false);
					await applyCommandLineTool(true);
				});
			}
		});
		// The app and the command-line tool have their own releases. By itself
		// the app only downloads a newer app and reads which command-line tool
		// is published; applying either takes a click on the update button.
		setTimeout(() => void checkForUpdates(false), 10_000);
		setInterval(() => void checkForUpdates(false), 4 * 60 * 60_000);
		void refresh();
	});
}
