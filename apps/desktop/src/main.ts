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
	powerMonitor,
	shell,
	WebContentsView,
} from "electron";
import type { PanelAction, PanelLink, PanelState, RunnerField } from "./api";
import { restartSupervisor } from "./cli";
import { log } from "./log";
import { setRunnerField } from "./runners-file";
import {
	onSetupChange,
	refreshSetup,
	saveSettings,
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
	try {
		const pending = JSON.parse(
			readFileSync(browserSignInFile(), "utf8"),
		) as BrowserSignIn;
		return pending.expires > Date.now() ? pending : undefined;
	} catch {
		return undefined;
	}
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
	const layout = () => {
		const { width, height } = window.getContentBounds();
		view.setBounds({ x: 0, y: 0, width, height });
	};
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
				if (rgb?.length === 3 && !window.isDestroyed())
					window.setBackgroundColor(
						`#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`,
					);
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
		// Remembered so the next launch opens the same organization.
		if (page?.protocol === "https:" && isOsHost(page.host) && status < 400)
			if (settings().host !== page.host) saveSettings({ host: page.host });
	});
	// The added name lets the sign-in page tell this app from a browser.
	view.webContents.setUserAgent(
		`${view.webContents.getUserAgent()} TedixDesktop/${app.getVersion()}`,
	);
	void view.webContents.loadURL(`${osOrigin()}/chat`);
	view.webContents.focus();
}

/** The small This Mac window: status and the day-to-day switches. */
function openPanel(): void {
	if (panel && !panel.isDestroyed()) return panel.show();
	panel = new BrowserWindow({
		width: 380,
		height: 600,
		title: "This Mac",
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
		width: 760,
		height: 560,
		title: "Set up this Mac",
		parent: mainWindow,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		titleBarStyle: "hiddenInset",
		backgroundColor: "#030303",
		webPreferences: localPage,
	});
	setupWindow = window;
	window.setMenuBarVisibility(false);
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// Coming back from the browser shows the new state at once.
	window.on("focus", () => void refreshSetup(false));
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
 * Looks for a newer app. When one is downloaded and checked it offers the
 * restart: once per version by itself, and every time the person asks.
 */
let offeredVersion: string | undefined;
async function checkForUpdates(asked: boolean): Promise<void> {
	try {
		const result = await checkForUpdate();
		if (result.kind === "ready") {
			setMenu();
			if (!asked && offeredVersion === result.version) return;
			offeredVersion = result.version;
			const restart = await tell(
				`Tedix ${result.version} is ready`,
				"Restart to update now, or choose Tedix → Restart to Update later.",
				["Restart to Update", "Later"],
			);
			if (restart === 0) restartToUpdate();
		} else if (asked)
			await tell(
				result.kind === "current"
					? "Tedix is up to date"
					: "Tedix cannot update itself here",
				result.kind === "current"
					? `You have version ${app.getVersion()}.`
					: result.reason,
			);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log(`update: check failed (${message})`);
		if (asked)
			await tell("Could not check for updates", `${message}. Try again later.`);
	}
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
					{
						label: "Sign In with Browser",
						click: () => void signInWithBrowser(),
					},
					{
						label: "Check for Updates…",
						click: () => void checkForUpdates(true),
					},
					...(readyVersion()
						? [{ label: "Restart to Update", click: restartToUpdate }]
						: []),
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
			if (name === "setup-window") return openSetup();
			if (name === "close-setup") {
				setupWindow?.close();
				mainWindow?.show();
				mainWindow?.focus();
			}
		});
		ipcMain.handle("setup", async (event, action: SetupAction, id: unknown) => {
			const asking = fromLocalPage(event);
			await setupAction(action, typeof id === "string" ? id : "", async () => {
				const options = {
					message: "Choose the project folder Tedix should work in",
					properties: ["openDirectory" as const],
				};
				const chosen = await dialog.showOpenDialog(asking, options);
				return chosen.canceled ? undefined : chosen.filePaths[0];
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
		setInterval(() => void refresh(), 5000);
		// The checklist opens by itself while the command-line tool or the
		// sign-in on this Mac is still to do.
		onSetupChange(() => void publish());
		void refreshSetup(true).then(() => {
			if (setupState().open) openSetup();
		});
		setTimeout(() => void checkForUpdates(false), 10_000);
		setInterval(() => void checkForUpdates(false), 4 * 60 * 60_000);
		void refresh();
	});
}
