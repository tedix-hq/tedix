import { join } from "node:path";
import {
	app,
	BrowserWindow,
	clipboard,
	ipcMain,
	type IpcMainInvokeEvent,
	Menu,
	type MenuItemConstructorOptions,
	powerMonitor,
	shell,
	WebContentsView,
} from "electron";
import type { PanelAction, PanelState, RunnerField } from "./api";
import { setRunnerField } from "./runners-file";
import { findTedix, lastLine, run } from "./shell";
import { loadStatus, type Status, summary } from "./status";

const OS_URL = "https://tedix.os.tedix.dev/chat";
// Height of the empty bar at the top that holds the window buttons and lets
// the window be dragged.
const TITLE_HEIGHT = 28;
/** The app folder: this package in dev, the packed app otherwise. */
const root = app.getAppPath();
const RUNNER_FIELDS: RunnerField[] = [
	"enabled",
	"machineName",
	"machineWriteMode",
];
/** The two local pages get the preload; the Tedix OS page never does. */
const localPage = {
	preload: join(root, "out/preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
};

let mainWindow: BrowserWindow | undefined;
let os: WebContentsView | undefined;
let panel: BrowserWindow | undefined;
let status: Status | undefined;
let lastOutput = "";
let busy = false;
/** A sign-in link that arrived before the window existed. */
let startUrl: string | undefined;

async function state(): Promise<PanelState> {
	status ??= await loadStatus(powerMonitor.isOnBatteryPower());
	return {
		status,
		summary: summary(status),
		lastOutput,
		busy,
		host: URL.parse(os?.webContents.getURL() ?? "")?.host ?? "",
		openAtLogin: app.isPackaged
			? app.getLoginItemSettings().openAtLogin
			: undefined,
	};
}

async function publish(): Promise<void> {
	const current = await state();
	for (const window of [mainWindow, panel])
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

async function tedix(args: string[]): Promise<void> {
	const file = findTedix();
	if (file) return command(file, args, "Done");
	lastOutput = "Tedix CLI not found";
	await publish();
}

/** The CLI has no restart command, so this restarts the supervisor's login service. */
async function restartRunners(): Promise<void> {
	if (process.platform === "darwin")
		return command(
			"/bin/launchctl",
			["kickstart", "-k", `gui/${process.getuid?.()}/dev.tedix.supervisor`],
			"Runners restarted",
		);
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

/**
 * `tedix://sign-in?link=<emailed link>`: the Tedix OS sign-in page sends this
 * from the browser so the emailed link finishes in this window instead.
 */
function openAppLink(value: string | undefined): void {
	const target = URL.parse(value ?? "");
	if (target?.protocol !== "tedix:" || target.host !== "sign-in") return;
	const link = target.searchParams.get("link") ?? "";
	if (!isTedixPage(link)) return;
	if (!os) {
		startUrl = link;
		return;
	}
	finishSignIn(link);
	mainWindow?.show();
	mainWindow?.focus();
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
			void view.webContents.loadURL(OS_URL);
	}, 8000);
}

/**
 * The main window: the Tedix OS chat under an empty, draggable title area.
 * The Tedix OS page gets no access to this app or the computer; its sign-in
 * lives in a session kept between launches.
 */
function createMainWindow(): void {
	const window = new BrowserWindow({
		width: 1280,
		height: 860,
		title: "Tedix",
		titleBarStyle: "hiddenInset",
		backgroundColor: "#0a0a0a",
		webPreferences: localPage,
	});
	mainWindow = window;
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	void window.loadFile(join(root, "strip.html"));

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
		view.setBounds({
			x: 0,
			y: TITLE_HEIGHT,
			width,
			height: height - TITLE_HEIGHT,
		});
	};
	layout();
	window.on("resize", layout);

	// A link that asks for a new window: Tedix pages load here, anything else
	// opens in the default browser. Redirects inside the page are left alone
	// so sign-in can leave and come back.
	view.webContents.setWindowOpenHandler(({ url }) => {
		if (isTedixPage(url)) void view.webContents.loadURL(url);
		else if (/^https?:/.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	// The title area takes the page's own background colour so the window
	// reads as one surface in light and dark.
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
	view.webContents.on("did-navigate", () => void publish());
	view.webContents.on("did-navigate-in-page", () => void publish());
	// The added name lets the sign-in page tell this app from a browser.
	view.webContents.setUserAgent(
		`${view.webContents.getUserAgent()} TedixDesktop/${app.getVersion()}`,
	);
	void view.webContents.loadURL(startUrl ?? OS_URL);
	view.webContents.focus();
}

/** The small This Mac window: status, switches and the three commands. */
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

function fromLocalPage(event: IpcMainInvokeEvent): void {
	const allowed = [mainWindow, panel].some(
		(window) =>
			window && !window.isDestroyed() && event.sender === window.webContents,
	);
	if (!allowed) throw new Error("Not allowed");
}

function navigate(action: "back" | "forward" | "reload"): void {
	const contents = os?.webContents;
	if (action === "back") contents?.navigationHistory.goBack();
	else if (action === "forward") contents?.navigationHistory.goForward();
	else contents?.reload();
}

// An emailed sign-in link only signs in the window that opens it, and a click
// in the mail app opens the default browser. This opens a copied link here.
async function pasteSignInLink(): Promise<void> {
	const url = (await clipboard.readText()).trim();
	if (isTedixPage(url)) finishSignIn(url);
}

function setMenu(): void {
	const thisMac: MenuItemConstructorOptions = {
		label: "This Mac…",
		accelerator: "CmdOrCtrl+Shift+M",
		click: openPanel,
	};
	const mac = process.platform === "darwin";
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: mac ? app.name : "Tedix",
				submenu: [
					...(mac ? [{ role: "about" as const }] : []),
					thisMac,
					{
						label: "Paste Sign-in Link",
						accelerator: "CmdOrCtrl+Shift+V",
						click: () => void pasteSignInLink(),
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
	// In dev the program is Electron itself, so the link type names this folder.
	if (app.isPackaged) app.setAsDefaultProtocolClient("tedix");
	else app.setAsDefaultProtocolClient("tedix", process.execPath, [root]);
	// macOS hands a clicked link over here; other systems pass it as an argument.
	app.on("open-url", (event, url) => {
		event.preventDefault();
		openAppLink(url);
	});
	openAppLink(appLink(process.argv));
	void app.whenReady().then(() => {
		setMenu();
		createMainWindow();

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
			if (name === "login") return tedix(["-w", "connect", "login"]);
			if (name === "update") return tedix(["update"]);
			if (name === "restart") return restartRunners();
			if (name === "open-panel") return openPanel();
			if (name === "back" || name === "forward" || name === "reload")
				return navigate(name);
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
		void refresh();
	});
}
