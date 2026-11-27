import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLocalTedix, reloadLocalTedix } from "./local-mode";
import { bundledLocalAvailable, removeOldRuntimes } from "./local-service";
import { openLocalModelChat } from "./local-model-window";
import { configDir } from "./shell";
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	ipcMain,
	type IpcMainInvokeEvent,
	Menu,
	type MenuItemConstructorOptions,
	nativeImage,
	nativeTheme,
	powerMonitor,
	type Rectangle,
	screen,
	shell,
	Tray,
	WebContentsView,
} from "electron";
import type {
	Appearance,
	PanelAction,
	PanelLink,
	PanelState,
	QuestionView,
	RunnerField,
	SettingsSection,
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
	type UpdateClick,
	updateCli,
} from "./cli";
import { log } from "./log";
import {
	onRunnersChange,
	pauseRunners,
	removeLoginService,
	runnersPaused,
	runnersProblem,
	runnersRunning,
	startRunners,
	stopRunners,
} from "./runners";
import { startExitGuard } from "./quit-guard";
import { readRunners, setRunnerField } from "./runners-file";
import {
	type AppSignIn,
	appSignInCode,
	onSetupChange,
	readAgentStatus,
	refreshSetup,
	saveSettings,
	setAppSignIn,
	type SetupAction,
	settings,
	setupAction,
	setupState,
} from "./setup";
import { desktopAppPath } from "./harness-target";
import { lastLine, run } from "./shell";
import { loadStatus, type Status, summary } from "./status";
import { bindTrayMenu } from "./tray-menu";
import { isOsHost, isOsPage, mainPageAllowed } from "./navigation";
import {
	downloadPercent,
	downloadUpdate,
	type FoundUpdate,
	findUpdate,
	readyVersion,
	restartToUpdate,
} from "./update";
import { isNewer } from "./version";
import { moveAppFolders, userDataFolder } from "./app-folders";

// The copy run from source keeps its own name and data folder and leaves the
// `tedix://` link type to the installed app, so the two never share a session
// or take each other's sign-in links. All of the app's data, logs included,
// lives in ~/Library/Application Support/Tedix; the copy from source uses its
// dev/ folder. Folders of earlier versions move there before the profile opens.
const appFolders = {
	appData: app.getPath("appData"),
	home: app.getPath("home"),
	packaged: app.isPackaged,
};
const folderMoves = moveAppFolders(appFolders);
app.setName(app.isPackaged ? "Tedix" : "Tedix Dev");
app.setPath("userData", userDataFolder(appFolders));
app.setAppLogsPath(join(userDataFolder(appFolders), "logs"));
for (const line of folderMoves) log(line);

/**
 * Tedix OS lives at `os.tedix.dev`, where the sign-in picks the organization,
 * and at `<organization>.os.tedix.dev`. The app opens the one used last.
 */
function osOrigin(): string {
	const host = settings().host ?? "";
	return `https://${isOsHost(host) ? host : "os.tedix.dev"}`;
}
const APP_LINKS = {
	"claude-app": "claude",
	"chatgpt-app": "chatgpt",
	"cursor-app": "cursor",
	"devin-app": "devin",
	"opencode-app": "opencode",
} as const;
const PANEL_LINKS: Record<
	Exclude<PanelLink, keyof typeof APP_LINKS>,
	string
> = {
	"chatgpt-plugins": "https://chatgpt.com/plugins",
	"install-chatgpt": "https://openai.com/chatgpt/desktop/",
	"install-claude": "https://claude.com/download",
	"claude-connectors": "https://claude.ai/settings/connectors",
	"install-claude-code": "https://claude.com/product/claude-code",
	"install-codex": "https://openai.com/codex/",
};
/** The app folder: this package in dev, the packed app otherwise. */
const root = app.getAppPath();
const RUNNER_FIELDS: RunnerField[] = [
	"enabled",
	"machineName",
	"machineWriteMode",
];
/** The app's own pages get the preload; the Tedix OS page never does. */
const localPage = {
	preload: join(root, "out/preload.cjs"),
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
};

let mainWindow: BrowserWindow | undefined;
let os: WebContentsView | undefined;
/** Settings, shown over the Tedix OS page inside the main window. */
let settingsView: WebContentsView | undefined;
let setupWindow: BrowserWindow | undefined;
let routingLaunch = false;
let status: Status | undefined;
let lastOutput = "";
let helpNote = "";
let busy = false;
/** A `tedix://` link that arrived before the window existed. */
let startLink: string | undefined;

/** What Settings last heard about updates, so it hears only of changes. */
let panelUpdate = "";
async function state(): Promise<PanelState> {
	status ??= await loadStatus();
	const update = updateView();
	panelUpdate = `${update.kind}|${update.text}`;
	return {
		status,
		setup: setupState(),
		summary: summary(status),
		lastOutput,
		helpNote,
		busy,
		openAtLogin: app.isPackaged
			? app.getLoginItemSettings().openAtLogin
			: undefined,
		app: {
			version: app.getVersion(),
			paused: runnersPaused(),
			onBattery: powerMonitor.isOnBatteryPower(),
			running: runnersRunning(),
			problem: runnersProblem(),
			updateReady: readyVersion(),
			cliOffer: cliOffer(),
			checked: lastCheck,
			checkedAt: lastCheckAt,
			updateFailure: failure ?? fetchFailure,
			update: { kind: update.kind, text: update.text },
			appearance: settings().appearance ?? "system",
			localWorkspace: bundledLocalAvailable(),
		},
	};
}

/** What the menus show that can change, so they are rebuilt only then. */
let menuKey: string | undefined;
function refreshMenu(): void {
	const key = `${runnersItem().label}|${updateItems(true)
		.map((item) => `${item.label}${item.enabled}`)
		.join()}`;
	if (key === menuKey || !app.isReady()) return;
	menuKey = key;
	setMenu();
}

/**
 * The update line of the menus, like other Mac apps: "Update Tedix" while an
 * update is ready (a click updates at once), a greyed-out line saying what
 * is happening while it checks, downloads or updates, "Update Failed · Try
 * Again" after a failure, and otherwise Check for Updates… (`withCheck`: the
 * Tedix menu only; the menu bar icon's menu shows nothing then).
 */
function updateItems(withCheck: boolean): MenuItemConstructorOptions[] {
	const busy = (label: string) => [{ label, enabled: false }];
	if (applying)
		return busy(applying === "Updating…" ? "Updating Tedix…" : applying);
	if (readyVersion() || cliOffer())
		return [{ label: "Update Tedix", click: () => void applyUpdate() }];
	const percent = downloadPercent();
	if (percent !== undefined) return busy(`Downloading Update… ${percent}%`);
	if (checking) return busy("Checking for Updates…");
	if (failure || fetchFailure)
		return [
			{ label: "Update Failed · Try Again", click: () => void applyUpdate() },
		];
	return withCheck
		? [
				{
					label: "Check for Updates…",
					click: () => void checkForUpdates(true),
				},
			]
		: [];
}

/** How the last look for updates ended: "Up to date" or why it failed. */
let lastCheck: string | undefined;
let lastCheckAt: number | undefined;

async function publish(): Promise<void> {
	refreshMenu();
	const current = await state();
	for (const contents of [settingsView?.webContents, setupWindow?.webContents])
		if (contents && !contents.isDestroyed()) contents.send("state", current);
	publishUpdate();
}

async function refresh(): Promise<void> {
	status = await loadStatus();
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

/** True when nothing runs, or the person agreed to stop what runs. */
async function agreeToStop(what: string, runs: number): Promise<boolean> {
	if (runs === 0) return true;
	const { response } = await ask({
		message: `${runs === 1 ? "1 task is" : `${runs} tasks are`} running. ${what} and stop ${runs === 1 ? "it" : "them"}?`,
		buttons: [what, "Cancel"],
		defaultId: 1,
		cancelId: 1,
	});
	return response === 0;
}

/** Stops the runners this app runs and starts them again. */
async function restartRunners(asked = false): Promise<void> {
	if (asked && !(await agreeToStop("Restart", status?.activeRuns ?? 0))) return;
	if (process.platform === "darwin") {
		busy = true;
		lastOutput = "Running…";
		await publish();
		const result = await restartSupervisor();
		busy = false;
		lastOutput = result.ok
			? "Runners restarted"
			: lastLine(result.output) || "The runners did not start";
		return refresh();
	}
	lastOutput = "Restart `tedix supervise` yourself on this system";
	await publish();
}

/**
 * The update entry: a small view of the app's own at the bottom left of the
 * main window, across the Tedix OS sidebar just above the account row. It
 * is there only while something can be applied: a newer app that is
 * downloaded and checked, or a newer command-line tool than the app's copy
 * in use. A click on it, or Check for Updates…, is the only thing that
 * applies either.
 */
let updateButton: WebContentsView | undefined;
/** How much room the entry's page asked for. */
let updateSize = { width: 0, height: 0 };
let applying: string | undefined;
/** Why applying an update did not finish. */
let failure: string | undefined;
/** Why the last download, or a check the person asked for, failed. */
let fetchFailure: string | undefined;
/** Check for Updates… is looking now. */
let checking = false;
/** Any look for updates is running, asked for or not. */
let looking = false;
/** The version this start updated to, for the one-time "Updated to …" line. */
let updatedTo: string | undefined;
let pageDark = nativeTheme.shouldUseDarkColors;
let layoutMain = () => {};
/** A newer published app, found by the last check, maybe not downloaded yet. */
let found: FoundUpdate | undefined;
/** Where the Tedix OS page's sidebar footer is, in the view's pixels. */
let sidebarSpot: { x: number; y: number; width: number; rail: boolean } | null =
	null;

/** A newer command-line tool, when `~/.local/bin/tedix` is the app's copy. */
function cliOffer(): string | undefined {
	const { kind, offer } = setupState().cli;
	return kind === "included" ? offer : undefined;
}

/** The marker an older app left to tell this Mac's runners to take no new tasks. */
const updateWaitingFile = () =>
	join(
		process.env.TEDIX_CONFIG_DIR || join(app.getPath("home"), ".tedix"),
		"app-update-waiting",
	);

function updateView(): UpdateView {
	const dark = pageDark;
	const place = !sidebarSpot ? "corner" : sidebarSpot.rail ? "rail" : "sidebar";
	const view = { dark, place } as const;
	if (applying) {
		const step = cliProgress().updating ?? "";
		const text = /^(Restarting|Waiting)/.test(step) ? "Restarting…" : applying;
		return { ...view, kind: "working", text, label: text };
	}
	if (failure || fetchFailure)
		return {
			...view,
			kind: "failed",
			text: "Update failed · Try again",
			label: "Update failed. Try again",
		};
	const percent = downloadPercent();
	if (percent !== undefined && !readyVersion()) {
		const text = `Downloading update… ${percent}%`;
		return { ...view, kind: "working", text, label: text };
	}
	// Check for Updates… shows on the entry at once, not only in the menu.
	if (checking && !readyVersion() && !cliOffer()) {
		const text = "Checking for updates…";
		return { ...view, kind: "working", text, label: text };
	}
	if (updatedTo) {
		const text = `Updated to ${updatedTo}`;
		return { ...view, kind: "done", text, label: text };
	}
	if (!readyVersion() && !cliOffer())
		return { ...view, kind: "hidden", text: "", label: "" };
	return {
		...view,
		kind: "ready",
		text: "Update ready",
		label: "Update Tedix",
	};
}

/**
 * The Tedix OS page keeps the space above its account row free while the
 * entry is there: the app adds the room and finds where it ended up.
 */
const ROOM = 48;
let roomRule: Promise<string> | undefined;
function makeRoom(on: boolean, again = false): void {
	const contents = os?.webContents;
	if (!contents || contents.isDestroyed()) return;
	if (on === Boolean(roomRule) && !again) return;
	const old = again ? undefined : roomRule;
	roomRule = on
		? contents.insertCSS(
				`[data-sidebar="footer"] { padding-top: ${ROOM}px !important; }`,
			)
		: undefined;
	void old?.then((rule) => contents.removeInsertedCSS(rule)).catch(() => {});
}

async function findSidebar(): Promise<void> {
	const contents = os?.webContents;
	if (!contents || contents.isDestroyed()) return;
	const shown = updateView().kind !== "hidden";
	makeRoom(shown);
	if (!shown) {
		sidebarSpot = null;
		return;
	}
	const spot = (await contents
		.executeJavaScript(
			`(() => {
				const footer = document.querySelector('[data-sidebar="sidebar"]:not([data-mobile]) [data-sidebar="footer"]');
				const box = footer?.getBoundingClientRect();
				if (!box?.width) return null;
				const style = getComputedStyle(footer);
				const left = parseFloat(style.paddingLeft) || 0;
				const right = parseFloat(style.paddingRight) || 0;
				return {
					x: Math.round(box.left + left),
					y: Math.round(box.top),
					width: Math.round(box.width - left - right),
					rail: footer.closest('[data-sidebar="sidebar"]').getAttribute("data-state") === "collapsed",
				};
			})()`,
		)
		.catch(() => null)) as typeof sidebarSpot;
	if (JSON.stringify(spot) === JSON.stringify(sidebarSpot)) return;
	sidebarSpot = spot;
	publishUpdate();
}

/**
 * The entry hides from the moment the sidebar opens or closes until it has
 * settled, so it never sits over the page at its old place.
 */
let sidebarMoving = false;
let watchingSidebar = false;
/** The page's sidebar takes 200 ms to open or close. */
const SIDEBAR_MOVE_MS = 300;
const SIDEBAR_CHANGE = `new Promise((resolve) => {
	const sidebar = document.querySelector('[data-sidebar="sidebar"]:not([data-mobile])');
	if (!sidebar) return resolve(false);
	// A re-render that writes the same state is not a move.
	const observer = new MutationObserver((changes) => {
		if (changes.every((change) => change.oldValue === sidebar.getAttribute("data-state"))) return;
		observer.disconnect();
		resolve(true);
	});
	observer.observe(sidebar, { attributes: true, attributeOldValue: true, attributeFilter: ["data-state"] });
	// A new page replaces the sidebar; the next watch finds the new one.
	setTimeout(() => {
		observer.disconnect();
		resolve(false);
	}, 10000);
})`;
async function watchSidebar(): Promise<void> {
	const contents = os?.webContents;
	if (watchingSidebar || !contents || contents.isDestroyed()) return;
	if (updateView().kind === "hidden") return;
	watchingSidebar = true;
	try {
		if (!(await contents.executeJavaScript(SIDEBAR_CHANGE).catch(() => false)))
			return;
		sidebarMoving = true;
		layoutMain();
		await new Promise((resolve) => setTimeout(resolve, SIDEBAR_MOVE_MS));
		sidebarMoving = false;
		await findSidebar();
		layoutMain();
	} finally {
		watchingSidebar = false;
	}
}

let findingSidebar = false;
function publishUpdate(): void {
	refreshMenu();
	const view = updateView();
	if (view.kind !== "hidden" && !sidebarSpot && !findingSidebar) {
		findingSidebar = true;
		void findSidebar().finally(() => {
			findingSidebar = false;
		});
	}
	if (`${view.kind}|${view.text}` !== panelUpdate) {
		panelUpdate = `${view.kind}|${view.text}`;
		void publish();
	}
	const contents = updateButton?.webContents;
	if (contents && !contents.isDestroyed())
		contents.send("update", updateView());
	layoutMain();
}

/** Logs once when the entry shows, and once when something holds it back. */
let entryNote = "";
function noteEntry(
	kind: UpdateView["kind"],
	text: string,
	place: UpdateView["place"],
	held: string,
): void {
	const note =
		kind === "hidden"
			? ""
			: held
				? `held back while ${held}`
				: `shown (${kind === "working" ? text.replace(/\s*\d+%$/, "") : text}, ${place})`;
	if (note === entryNote) return;
	entryNote = note;
	if (note) log(`update: entry ${note}`);
}

function sayDone(line: string): void {
	log(`update: ${line}`);
}

/**
 * Puts the newest command-line tool in place and reloads the background
 * service. Only ever reached from the person's click on the update entry or
 * Check for Updates…: directly, or on the start that follows it (see
 * `takeUpdateClick`).
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
			cliProgress().reloadedAt >= from ? " Runners restarted." : ""
		}`,
	);
}

/** Runs one of the entry's jobs and shows how it ended. */
async function working(text: string, job: () => Promise<void>): Promise<void> {
	if (applying) return;
	applying = text;
	failure = undefined;
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
 * Applies what is ready, after the person chose it. With a newer app it
 * restarts into it, and the note it leaves lets that start put the newest
 * command-line tool in place. With only a newer command-line tool it does
 * that now, without a restart.
 */
function updateNow(): Promise<void> {
	return working("Updating…", async () => {
		if (readyVersion()) {
			// The next start reopens this page and looks the same until it has.
			const page = os?.webContents.getURL();
			noteUpdateClick(page && isOsPage(page) ? page : undefined, pageDark);
			await showRestarting(pageDark);
			const before = quitSource;
			quitSource = "an update";
			try {
				await restartToUpdate();
			} catch (error) {
				quitSource = before;
				takeUpdateClick();
				hideRestarting();
				throw error;
			}
			// The app quits now; the entry keeps saying so until it does. If
			// it is still running a minute later, the update did not happen.
			await new Promise((done) => setTimeout(done, 60_000).unref());
			quitSource = "the Dock or macOS";
			throw new Error("Tedix did not restart. Try again.");
		}
		await applyCommandLineTool(false);
	});
}

/** The question window that is open now, and how it answers. */
let question:
	| {
			window: BrowserWindow;
			view: QuestionView;
			settle: (answer: Electron.MessageBoxReturnValue) => void;
	  }
	| undefined;

/**
 * Asks in the app's own small window (question.html) rather than a native
 * dialog: macOS stacks a native dialog's buttons when it has little text and
 * opens it on any screen. This one keeps the buttons in a row and opens
 * centred on the screen the Tedix window is on. Every button is a real,
 * reachable button, and closing the window answers `cancelId`.
 */
/** Settles once the last answered question's window is gone. */
let questionClosing: Promise<void> = Promise.resolve();

async function ask(
	options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
	await app.whenReady();
	question?.window.close();
	const view: QuestionView = {
		message: options.message,
		detail: options.detail ?? "",
		buttons: options.buttons?.length ? options.buttons : ["OK"],
		defaultId: options.defaultId ?? 0,
		cancelId:
			options.cancelId ?? Math.max((options.buttons?.length ?? 1) - 1, 0),
		checkboxLabel: options.checkboxLabel,
		checkboxChecked: options.checkboxChecked,
	};
	const width = 420;
	const anchor =
		mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
			? mainWindow.getBounds()
			: undefined;
	const area = (
		anchor
			? screen.getDisplayMatching(anchor)
			: screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	).workArea;
	const window = new BrowserWindow({
		width,
		height: 200,
		useContentSize: true,
		x: Math.round(area.x + (area.width - width) / 2),
		y: Math.round(area.y + area.height * 0.25),
		show: false,
		frame: false,
		title: options.message,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		alwaysOnTop: true,
		backgroundColor: windowColour(),
		webPreferences: localPage,
	});
	window.setMenuBarVisibility(false);
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	return new Promise((resolve) => {
		let answered = false;
		const settle = (answer: Electron.MessageBoxReturnValue) => {
			if (answered) return;
			answered = true;
			if (question?.window === window) question = undefined;
			resolve(answer);
			if (!window.isDestroyed()) {
				questionClosing = new Promise((closed) =>
					window.once("closed", () => closed()),
				);
				window.close();
			}
		};
		question = { window, view, settle };
		window.on("closed", () =>
			settle({
				response: view.cancelId,
				checkboxChecked: view.checkboxChecked === true,
			}),
		);
		void window.loadFile(join(root, "question.html"));
		// The page sizes and shows the window; if it never does, show it
		// anyway, so a question can never wait unseen.
		setTimeout(() => {
			if (answered || window.isDestroyed() || window.isVisible()) return;
			log("question: shown before its page reported a size");
			app.focus({ steal: true });
			window.show();
			window.focus();
		}, 3000);
	});
}

/**
 * The click on "Update ready". With no task running it updates at once; with
 * tasks running it asks one question: update when they finish, or now.
 */
async function applyUpdate(): Promise<void> {
	if (applying) return;
	// After a failed download or check, a click looks and downloads again,
	// then updates.
	if (fetchFailure && !failure) {
		fetchFailure = undefined;
		return checkForUpdates(true);
	}
	// After a failed update, a click tries again; runners that stayed down
	// are started again first.
	if (failure) {
		const down = cliProgress().last?.down;
		failure = undefined;
		publishUpdate();
		if (down)
			return working("Restarting…", async () => {
				const result = await restartSupervisor();
				if (!result.ok)
					throw new Error("Tasks on this Mac did not start again.");
				sayDone("Tasks run again.");
			});
	}
	// No question: the person chose to update, and running tasks keep going
	// (their runner restarts on the new version when the task ends).
	if (readyVersion() || cliOffer()) return updateNow();
}

/** Downloads and checks the found app in the background. */
async function download(): Promise<boolean> {
	if (!found) return false;
	try {
		// The menus and the entry show how far it is, about ten times a second.
		await downloadUpdate(found, publishUpdate);
		fetchFailure = undefined;
		publishUpdate();
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		log(`update: download failed (${reason})`);
		fetchFailure = `The update did not download: ${reason}`;
		publishUpdate();
		return false;
	}
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
	const window =
		mainWindow?.isDestroyed() || !mainWindow?.isVisible()
			? undefined
			: mainWindow;
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
	const pending = await prepareSignIn();
	const page = new URL("/auth/desktop/sign-in", pending.origin);
	page.searchParams.set("key", pending.publicKey);
	await shell.openExternal(page.href);
	void readAppSignIn();
}

/**
 * Sign in: one sign-in covers this app and its command-line tool. The
 * command-line tool signs in through the browser if it is not signed in yet;
 * this app then signs in with that same login, so the person signs in and
 * consents once. If that does not work, the browser sign-in still does.
 */
async function signIn(): Promise<void> {
	const pending = await prepareSignIn();
	let code: string;
	try {
		code = await appSignInCode(pending.origin ?? osOrigin(), pending.publicKey);
	} catch (error) {
		log(`sign-in: command-line login not used (${(error as Error).message})`);
		if (setupState().signedIn) return signInWithBrowser();
		return;
	}
	log("sign-in: signed in with the command-line tool's login");
	await finishBrowserSignIn(code);
}

/** The key this app's sign-in is sealed to, reused while one is waiting. */
async function prepareSignIn(): Promise<BrowserSignIn> {
	let pending = pendingBrowserSignIn();
	log(`sign-in: started (${pending ? "same" : "new"} request)`);
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
	return pending;
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
	if (!pending) await readAppSignIn();
	// A code from an older browser tab while this app is already signed in:
	// nothing is missing, so there is nothing to say.
	if (!pending && appSignIn.state === "in")
		return log("sign-in: code ignored, already signed in");
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
 * `tedix://setup` opens Settings at Coding tools, or the first-run setup
 * while this Mac is not set up yet.
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
	showMain();
	// `tedix://setup`: the Tedix OS page's "Set up this Mac" button.
	if (target.host === "setup") {
		log("link: setup asked for");
		return setupState().open ? openSetup() : openSettings("tools");
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
/**
 * The main window's size and place, kept in the app's data folder (each copy
 * has its own, so the copy run from source never moves the installed one).
 */
const windowFile = () => join(app.getPath("userData"), "window.json");
/** The person chose Try it on this Mac in the first-run setup. */
let localChosen = false;
/** There once the person has been through the first-run setup. */
const setUpFile = () => join(app.getPath("userData"), "set-up");
/**
 * A first run: this app has never been set up here and never kept a window
 * size (an install from before this marker always did). The setup opens
 * before the main window, which shows when the setup closes.
 */
const firstRun = () => !existsSync(setUpFile()) && !existsSync(windowFile());

/** The last size and place, when they still fit on a screen that is connected now. */
function savedBounds(): Rectangle | undefined {
	let saved: Partial<Rectangle>;
	try {
		saved = JSON.parse(readFileSync(windowFile(), "utf8")) as Rectangle;
	} catch {
		return undefined;
	}
	const { x, y, width, height } = saved;
	if (![x, y, width, height].every((part) => Number.isFinite(part)))
		return undefined;
	const bounds = { x: x!, y: y!, width: width!, height: height! };
	// The title bar must be on a screen, or the window could not be moved back.
	const onScreen = screen.getAllDisplays().some(({ workArea }) => {
		const left = Math.max(bounds.x, workArea.x);
		const right = Math.min(
			bounds.x + bounds.width,
			workArea.x + workArea.width,
		);
		return (
			right - left >= 100 &&
			bounds.y >= workArea.y &&
			bounds.y + 40 <= workArea.y + workArea.height
		);
	});
	return onScreen ? bounds : undefined;
}

/** A first window: most of the screen it opens on, capped, centred. */
function defaultBounds(): Rectangle {
	const { workArea } = screen.getDisplayNearestPoint(
		screen.getCursorScreenPoint(),
	);
	const width = Math.min(
		workArea.width,
		Math.max(1100, Math.min(Math.round(workArea.width * 0.8), 1680)),
	);
	const height = Math.min(
		workArea.height,
		Math.max(720, Math.min(Math.round(workArea.height * 0.85), 1100)),
	);
	return {
		x: workArea.x + Math.round((workArea.width - width) / 2),
		y: workArea.y + Math.round((workArea.height - height) / 2),
		width,
		height,
	};
}

/** Quit was chosen: windows really close now instead of hiding. */
let quitting = false;

/** This start follows a click to update: what it reopens and how it looks. */
let restoring: UpdateClick | undefined;
/**
 * "Restarting Tedix…" over the whole main window while an update restarts
 * the app, instead of an empty window: shown by the app that quits, and by
 * the start that follows until its page has loaded.
 */
let restartingView: WebContentsView | undefined;
let restarted = () => {};
/** Settles once the start after an update shows its page again. */
const pageBack = new Promise<void>((settle) => {
	restarted = settle;
});
/** Settles once the screen has painted, or after a second at most. */
function showRestarting(dark: boolean): Promise<void> {
	const window = mainWindow;
	if (!window || window.isDestroyed() || restartingView)
		return Promise.resolve();
	const view = new WebContentsView({ webPreferences: localPage });
	restartingView = view;
	view.setBackgroundColor(dark ? "#0b0b0c" : "#fafafa");
	view.webContents.on("will-navigate", (event) => event.preventDefault());
	const { width, height } = window.getContentBounds();
	view.setBounds({ x: 0, y: 0, width, height });
	window.contentView.addChildView(view);
	const painted = new Promise<void>((done) => {
		view.webContents.once("did-finish-load", () => setTimeout(done, 100));
		setTimeout(done, 1000);
	});
	void view.webContents.loadFile(
		join(root, "restarting.html"),
		dark ? { hash: "dark" } : {},
	);
	return painted;
}
function hideRestarting(): void {
	restarted();
	const view = restartingView;
	restartingView = undefined;
	if (!view) return;
	if (mainWindow && !mainWindow.isDestroyed())
		mainWindow.contentView.removeChildView(view);
	view.webContents.close();
}

/** How long "Updated to …" stays after the restart; the entry fades out before. */
const UPDATED_MS = 10_000;
async function sayUpdated(): Promise<void> {
	await pageBack;
	updatedTo = app.getVersion();
	publishUpdate();
	setTimeout(() => {
		updatedTo = undefined;
		publishUpdate();
	}, UPDATED_MS);
}

/** Shows the main window and puts Tedix back in the Dock. */
function showMain(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	void app.dock?.show();
	window.show();
	window.focus();
}

async function showLaunchWindow(): Promise<void> {
	// Saved window bounds and a closed setup window do not prove sign-in.
	const browserSession = os?.webContents.session;
	let hasSession = false;
	try {
		const response = await browserSession?.fetch(
			`${osOrigin()}/auth/session-broker/status`,
			{
				cache: "no-store",
				credentials: "include",
				redirect: "error",
				signal: AbortSignal.timeout(2500),
			},
		);
		const status = (await response?.json()) as
			| { authenticated?: boolean; renewalRequired?: boolean }
			| undefined;
		hasSession =
			status?.authenticated === true || status?.renewalRequired === true;
	} catch {
		// The welcome screen still offers the demo when the network is down.
	}
	if (
		quitting ||
		localChosen ||
		mainWindow?.isVisible() ||
		setupWindow?.isVisible()
	)
		return;
	if (hasSession || appSignIn.state === "in") showMain();
	else openSetup();
}

/** Without a visible window, Tedix lives in the menu bar only. */
function updateDock(): void {
	if (process.platform !== "darwin" || quitting) return;
	const shown = [mainWindow, setupWindow].some(
		(window) => window && !window.isDestroyed() && window.isVisible(),
	);
	if (!shown) app.dock?.hide();
}

function createMainWindow(): void {
	const window = new BrowserWindow({
		...(savedBounds() ?? defaultBounds()),
		show: false,
		minWidth: 720,
		minHeight: 520,
		title: "Tedix",
		titleBarStyle: "hiddenInset",
		// Centres the buttons in the page's 56 px top bar.
		trafficLightPosition: { x: 20, y: 20 },
		backgroundColor: restoring && !restoring.dark ? "#fafafa" : "#0a0a0a",
	});
	mainWindow = window;
	// Coming back to the window looks for an update when the last look is
	// older than 15 minutes, like Hermes; the hourly look stays as it is.
	window.on("focus", () => {
		if (Date.now() - (lastCheckAt ?? 0) > FOCUS_CHECK_MS)
			void checkForUpdates(false);
	});
	// Closing the window leaves Tedix in the menu bar, with its runners;
	// only Quit ends the app.
	// Kept whenever it changes: an update or a quit can end the app before
	// the window gets to close.
	const keepBounds = () => {
		if (window.isDestroyed() || window.isFullScreen()) return;
		try {
			writeFileSync(windowFile(), JSON.stringify(window.getNormalBounds()));
		} catch (error) {
			log(`window: size not kept (${(error as Error).message})`);
		}
	};
	window.on("resized", keepBounds);
	window.on("moved", keepBounds);
	window.on("close", (event) => {
		keepBounds();
		if (quitting) return;
		event.preventDefault();
		if (window.isFullScreen()) {
			window.once("leave-full-screen", () => window.hide());
			window.setFullScreen(false);
		} else window.hide();
	});
	window.on("hide", updateDock);

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
	// The update entry, above the account row of the page's sidebar.
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
		settingsView?.setBounds({ x: 0, y: 0, width, height });
		restartingView?.setBounds({ x: 0, y: 0, width, height });
		const { kind, place, text } = updateView();
		// The entry's place comes from the sidebar, or its own width in the
		// corner; until its page reports that width the corner uses a fair
		// guess, so a download shows from its first moment.
		const held =
			kind === "hidden"
				? ""
				: settingsView?.getVisible()
					? "Settings is open"
					: sidebarMoving
						? "the sidebar is moving"
						: "";
		const shown = kind !== "hidden" && !held;
		button.setVisible(shown);
		noteEntry(kind, text, place, held);
		if (!shown) return;
		const entry = 32;
		const spot = sidebarSpot;
		const fits =
			spot && spot.y + 8 + entry <= height && spot.x + spot.width <= width;
		button.setBounds(
			place === "corner" || !spot || !fits
				? {
						x: 12,
						y: height - 12 - entry,
						width: Math.min(updateSize.width || 240, width - 24),
						height: entry,
					}
				: place === "rail"
					? {
							x: spot.x + Math.round((spot.width - entry) / 2),
							y: spot.y + 8,
							width: entry,
							height: entry,
						}
					: { x: spot.x, y: spot.y + 8, width: spot.width, height: entry },
		);
	};
	layoutMain = layout;
	layout();
	window.on("resize", layout);
	// The page's sidebar can open, close or move; the entry follows it.
	setInterval(() => {
		void findSidebar();
		void watchSidebar();
	}, 1000);

	// Editors and other sites belong in the browser, outside the OS view.
	view.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("tedix:")) openAppLink(url);
		else if (refusesAppWindows(url)) void signIn();
		else if (isOsPage(url)) void view.webContents.loadURL(url);
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
		if (mainPageAllowed(url)) return;
		event.preventDefault();
		// The page's own buttons for this app, such as Set up this Mac.
		if (url.startsWith("tedix:")) openAppLink(url);
		else if (refusesAppWindows(url)) void signIn();
		else if (/^https?:/.test(url)) void shell.openExternal(url);
	};
	view.webContents.on("will-navigate", leaveForBrowser);
	view.webContents.on("will-redirect", leaveForBrowser);
	// Page addresses without anything after `?` or `#`, to trace a sign-in.
	view.webContents.on("did-navigate", (_event, url, status) => {
		const page = URL.parse(url);
		log(`page: ${page?.host}${page?.pathname} (${status})`);
		// A new page has lost the room made for the update entry.
		if (roomRule) makeRoom(true, true);
		// Remembered so the next launch opens the same organization.
		if (page?.protocol === "https:" && isOsHost(page.host) && status < 400)
			if (settings().host !== page.host) saveSettings({ host: page.host });
		void readAppSignIn();
	});
	// The added name lets the sign-in page tell this app from a browser.
	view.webContents.setUserAgent(
		`${view.webContents.getUserAgent()} TedixDesktop/${app.getVersion()}`,
	);
	// After an update, the page that was open, behind "Restarting Tedix…"
	// until it has loaded.
	const page = restoring?.page;
	if (restoring) {
		void showRestarting(restoring.dark);
		view.webContents.once("did-finish-load", hideRestarting);
		view.webContents.once("did-fail-load", hideRestarting);
		setTimeout(hideRestarting, 20_000);
	}
	void view.webContents.loadURL(
		page && isOsPage(page) ? page : `${osOrigin()}/chat`,
	);
	view.webContents.focus();
}

/** The background of the app's own two windows, so they do not flash while loading. */
const windowColour = () =>
	nativeTheme.shouldUseDarkColors ? "#1a1a1c" : "#fafafa";

/**
 * Settings: every setting of the app in one place, a panel over the
 * dimmed Tedix OS page, the way chat apps show theirs. Cmd+, opens it, and
 * so does Settings… in the menu bar icon's menu; Escape, the close button
 * or a click beside the panel goes back to the page.
 */
function openSettings(section?: SettingsSection): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	showMain();
	let view = settingsView;
	if (!view) {
		view = new WebContentsView({ webPreferences: localPage });
		settingsView = view;
		// Clear, so the Tedix page shows dimmed around the Settings panel.
		view.setBackgroundColor("#00000000");
		view.webContents.on("will-navigate", (event) => event.preventDefault());
		view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		mainWindow.contentView.addChildView(view);
		void view.webContents.loadFile(join(root, "settings.html"), {
			hash: section ?? "general",
		});
	} else if (section) view.webContents.send("section", section);
	view.setVisible(true);
	layoutMain();
	view.webContents.focus();
	void refresh();
	void refreshSetup(true);
	void readAppSignIn();
}

function closeSettings(): void {
	if (!settingsView?.getVisible()) return;
	settingsView.setVisible(false);
	layoutMain();
	os?.webContents.focus();
}

/**
 * The Set up this Mac window: one step per screen. It opens by itself while
 * the sign-in on this Mac is still to do, from the menu, and from a
 * `tedix://setup` link.
 */
function openSetup(): void {
	void app.dock?.show();
	if (setupWindow && !setupWindow.isDestroyed()) return setupWindow.show();
	const window = new BrowserWindow({
		width: 960,
		height: 620,
		title: "Set up this Mac",
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
	window.on("closed", () => {
		setupWindow = undefined;
		writeFileSync(setUpFile(), new Date().toISOString());
		// After the first-run setup the Tedix window comes next, unless the
		// person chose to try Tedix on this Mac without an account.
		if (
			!localChosen &&
			mainWindow &&
			!mainWindow.isDestroyed() &&
			!mainWindow.isVisible()
		)
			showMain();
		updateDock();
	});
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// Coming back, from the browser or from installing or opening an app,
	// looks for apps again in full, at most every 15 seconds.
	let lookedAt = Date.now();
	window.on("focus", () => {
		const deep = Date.now() - lookedAt > 15_000;
		if (deep) lookedAt = Date.now();
		void refreshSetup(deep);
		void readAppSignIn();
	});
	void window.loadFile(join(root, "setup.html"));
	void refresh();
	void refreshSetup(true);
}

async function saveClaudePlugin(window: BrowserWindow): Promise<void> {
	const filename = "Tedix-Claude.zip";
	try {
		const bytes = readFileSync(join(root, "out", filename));
		const choice = await dialog.showSaveDialog(window, {
			title: "Save the Tedix plugin for Claude",
			defaultPath: join(app.getPath("downloads"), filename),
			filters: [{ name: "Plugin ZIP", extensions: ["zip"] }],
		});
		if (choice.canceled || !choice.filePath) return;
		writeFileSync(choice.filePath, bytes);
	} catch (error) {
		await dialog.showMessageBox(window, {
			type: "warning",
			message: "Could not save the Claude plugin",
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}

function fromLocalPage(event: IpcMainInvokeEvent): BrowserWindow {
	if (settingsView && event.sender === settingsView.webContents && mainWindow)
		return mainWindow;
	const window = [setupWindow].find(
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
 * Looks for a newer app and command-line tool and downloads a newer app in
 * the background; it applies nothing. A newer version only brings up the
 * "Update ready" entry. `asked`: the person chose Check for Updates…, so it
 * updates like a click on the entry, or says Tedix is up to date.
 */
async function checkForUpdates(
	asked: boolean,
	inSettings = false,
): Promise<void> {
	if (checking) return;
	// One look at a time: a look by itself (timer, window focus) runs
	// without "Checking…", and a second one would download twice.
	if (looking && !asked) return;
	looking = true;
	const from = Date.now();
	log(
		`update: checking (${!asked ? "by itself" : inSettings ? "asked in Settings" : "asked from the menu"})`,
	);
	let problem = "";
	let failed = false;
	if (asked) {
		checking = true;
		fetchFailure = undefined;
		publishUpdate();
		// Settings covers the sidebar entry; its version row says the same.
		if (!inSettings && settingsView?.getVisible())
			settingsView.webContents.send("section", "general");
	}
	try {
		try {
			const result = await findUpdate();
			if (result.kind === "unavailable") problem = result.reason;
			found = result.kind === "found" ? result.update : undefined;
		} catch (error) {
			problem = `Could not check for updates: ${error instanceof Error ? error.message : String(error)}. Try again later.`;
			failed = true;
		}
		// The app downloads while the command-line tool is looked up; the
		// download shows its own percent, so the check does not wait on it.
		const fetched =
			found && readyVersion() !== found.version
				? download()
				: Promise.resolve(true);
		// A step that hangs must not keep "Checking…" up for good.
		const settled = await Promise.race([
			Promise.all([lookForCliUpdate(asked), refreshSetup(false)]).then(
				() => true,
			),
			new Promise<false>((done) => setTimeout(() => done(false), CHECK_MS)),
		]);
		if (!settled) log("update: the command-line tool check is still running");
		if (!(await fetched)) {
			problem ||= "The update did not download. Try again later.";
			failed = true;
		}
	} catch (error) {
		problem ||= `Could not check for updates: ${error instanceof Error ? error.message : String(error)}. Try again later.`;
		failed = true;
	} finally {
		checking = false;
		looking = false;
	}
	lastCheck = problem || "Up to date";
	lastCheckAt = Date.now();
	log(
		`update: check ended in ${Math.round((Date.now() - from) / 1000)} s: ${problem || (readyVersion() ? `${readyVersion()} is ready` : "up to date")}`,
	);
	// A failed look the person asked for shows on the entry, like a failed
	// download; a failed look by itself is tried again in a few minutes.
	clearTimeout(checkAgain);
	if (failed)
		checkAgain = setTimeout(() => void checkForUpdates(false), 5 * 60_000);
	if (failed && asked) fetchFailure ??= problem;
	if (!problem) fetchFailure = undefined;
	publishUpdate();
	if (!asked || failed || inSettings) return void publish();
	// Chosen from the menu: update at once, or show the result in Settings.
	if (readyVersion() || cliOffer()) return applyUpdate();
	openSettings("general");
	void publish();
}
/** How old the last look may be before coming back to the window looks again. */
const FOCUS_CHECK_MS = 15 * 60_000;
/** The sooner look after one that failed; the hourly one stays as it is. */
let checkAgain: ReturnType<typeof setTimeout> | undefined;
/** How long a check waits for the command-line tool and setup state. */
const CHECK_MS = 60_000;

function newChatItem(): MenuItemConstructorOptions {
	return {
		label: "New Chat…",
		accelerator: "CmdOrCtrl+N",
		click: () => openInputBar(),
	};
}

function setMenu(): void {
	const settingsItem: MenuItemConstructorOptions = {
		label: "Settings…",
		accelerator: "CmdOrCtrl+,",
		click: () => openSettings(),
	};
	const mac = process.platform === "darwin";
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: mac ? app.name : "Tedix",
				// Short, like other Mac apps: everything else is in Settings.
				submenu: [
					...(mac ? [{ role: "about" as const }] : []),
					...updateItems(true),
					{ type: "separator" },
					settingsItem,
					{ label: "Set up this Mac…", click: () => openSetup() },
					{ label: "Check this Mac…", click: checkThisMac },
					{ type: "separator" },
					...(mac
						? [
								{ role: "services" as const },
								{ type: "separator" as const },
								{ role: "hide" as const },
								{ role: "hideOthers" as const },
								{ role: "unhide" as const },
								{ type: "separator" as const },
							]
						: []),
					{
						label: mac ? `Quit ${app.name}` : "Quit",
						accelerator: "CmdOrCtrl+Q",
						click: () => quitFrom("the app menu or Cmd+Q"),
					},
				],
			},
			{ label: "File", submenu: [newChatItem()] },
			{ role: "editMenu" },
			{
				label: "View",
				submenu: [
					{
						label: "Tedix Home",
						accelerator: "CmdOrCtrl+Shift+H",
						click: () => void openOsPage("/"),
					},
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
						click: (_item, focused) => {
							if (!reloadLocalTedix(focused)) navigate("reload");
						},
					},
				],
			},
			{ role: "windowMenu" },
		]),
	);
}

/**
 * The menu bar icon: the astronaut of the app icon, from the helmet to the
 * waving hand, cut out of its dark tile. Its light parts become one colour
 * that macOS tints for light and dark menu bars. It is 18 points high, the
 * size of the other icons in the menu bar.
 */
function trayImage(): Electron.NativeImage {
	const points = 18;
	const scale = 2;
	const size = points * scale;
	const icon = nativeImage.createFromPath(join(root, "assets/icon.png"));
	// Where the figure's upper half is in the 1024-pixel icon.
	const unit = icon.getSize().width / 1024;
	const pixels = icon
		.crop({
			x: Math.round(290 * unit),
			y: Math.round(195 * unit),
			width: Math.round(520 * unit),
			height: Math.round(520 * unit),
		})
		.resize({ width: size, height: size, quality: "best" })
		.toBitmap();
	for (let at = 0; at < pixels.length; at += 4) {
		const light = (pixels[at]! + pixels[at + 1]! + pixels[at + 2]!) / 3;
		// The suit is opaque, its purple parts half so, the tile and visor clear.
		const shown = pixels[at + 3] === 0 ? 0 : (light - 60) / 120;
		pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
		pixels[at + 3] = Math.round(255 * Math.max(0, Math.min(1, shown)));
	}
	const image = nativeImage.createFromBitmap(pixels, {
		width: size,
		height: size,
		scaleFactor: scale,
	});
	image.setTemplateImage(true);
	return image;
}

/** One line on this Mac's runners for the menu bar menu. */
function runnersLine(): string {
	if (runnersPaused()) return "Tasks are paused";
	if (runnersProblem() || !runnersRunning()) return "Tasks are not running";
	const runs = status?.activeRuns ?? 0;
	return `${runs} ${runs === 1 ? "task" : "tasks"} running`;
}

/**
 * Pause or Resume, in the menu bar icon's menu and in the app menu. The app
 * menu copy is the one that accessibility and scripts can reach: the icon's
 * menu opens only on a real right click.
 */
function runnersItem(): MenuItemConstructorOptions {
	return runnersPaused() || !runnersRunning()
		? { label: "Resume Tasks", click: () => void restartRunners() }
		: {
				// Pausing stops the tasks running on this Mac, so it says how many.
				label: "Pause Tasks",
				click: () => void pauseAsked(),
			};
}

/** Pauses the runners; asks first when that stops running tasks. */
async function pauseAsked(): Promise<void> {
	if (!(await agreeToStop("Pause", status?.activeRuns ?? 0))) return;
	await pauseRunners();
	await refresh();
}

/**
 * Restarts one runner: its process ends and the supervisor starts it again
 * by itself. The other runners and their tasks keep running.
 */
async function restartRunner(index: number): Promise<void> {
	const runner = status?.runners.find((row) => row.index === index);
	if (!runner?.key || !/^[0-9a-f]{16}$/.test(runner.key)) return;
	const runs = status?.activeTasks.filter(
		(task) => task.executor === runner.executor,
	).length;
	if (!(await agreeToStop("Restart", runs ?? 0))) return;
	try {
		const record = JSON.parse(
			readFileSync(
				join(configDir(), "supervisor", "runners", `${runner.key}.json`),
				"utf8",
			),
		) as { pid?: unknown };
		const pid = Number(record.pid);
		if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("no process");
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			process.kill(pid, "SIGTERM");
		}
		log(`runners: restarting the ${runner.executor} runner (pid ${pid})`);
		lastOutput = "";
	} catch (error) {
		lastOutput = `Could not restart ${runner.executor}: ${error instanceof Error ? error.message : String(error)}`;
	}
	await refresh();
}

/** The runners start when none run, unless the person paused them. */
async function startRunnersIfStopped(): Promise<void> {
	if (runnersPaused() || runnersRunning()) return;
	const result = await startRunners();
	if (!result.ok) log(`runners: not started (${lastLine(result.output)})`);
}

function applyAppearance(mode: Appearance): void {
	nativeTheme.themeSource = mode;
}

/**
 * Who asked the app to quit, for the log. Without one of the app's own Quit
 * items or a TERM signal, it was the Dock, an update, or macOS itself.
 */
let quitSource = "the Dock or macOS";
function quitFrom(source: string): void {
	quitSource = source;
	app.quit();
}
/** Ends the app if a quit has not finished after the runners stopped. */
let quitTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Once the runners are stopped nothing may hold the quit: a page that asks
 * to stay open, a quit macOS answered before the runners stopped, anything
 * else gets five seconds, then the app exits anyway.
 */
function exitSoon(): void {
	if (quitTimer) return;
	// From outside the app as well: a quit that stalls stops this timer too.
	startExitGuard(process.pid, 8);
	quitTimer = setTimeout(() => {
		log("quit: still open five seconds after the runners stopped; exiting");
		app.exit(0);
	}, 5000);
}
/** Set once the person agreed to stop running tasks by quitting. */
let quitAgreed = false;

/**
 * A quit by hand while tasks run asks first, so a stray Cmd+Q does not stop
 * the work on this Mac. Updates and TERM signals quit without asking.
 */
async function askToQuit(): Promise<void> {
	// Quit again while the question is open: the person means it.
	if (quitAsking) {
		log("quit: asked again while the question was open; quitting");
		quitAgreed = true;
		question?.settle({ response: 1, checkboxChecked: false });
		return;
	}
	const runs = status?.activeRuns ?? 0;
	log(`quit: asking first, ${runs} running`);
	quitAsking = true;
	const { response } = await ask({
		message: `${runs === 1 ? "1 task is" : `${runs} tasks are`} running. Quit Tedix?`,
		detail: `${runs === 1 ? "It continues" : "They continue"} where ${runs === 1 ? "it" : "they"} stopped when you open Tedix again.`,
		buttons: ["Cancel", "Quit"],
		defaultId: 0,
		cancelId: 0,
	});
	quitAsking = false;
	if (quitting) return;
	if (response !== 1) return log("quit: cancelled, tasks keep running");
	log("quit: confirmed");
	quitAgreed = true;
	app.quit();
}
let quitAsking = false;
/** A downloaded update is being put in place as the app quits. */
let installingOnQuit = false;

let tray: Tray | undefined;

/**
 * Check this Mac: opens Settings where the result shows and runs every setup
 * check again; the row names the first thing to fix.
 */
function checkThisMac(): void {
	log("check: Check this Mac chosen");
	openSettings("general");
	void refreshSetup(true);
}

/** Right click on the menu bar icon. */
function trayMenu(): Menu {
	return Menu.buildFromTemplate([
		{ label: "Open Tedix", click: showMain },
		newChatItem(),
		{ type: "separator" },
		// One line only when tasks are paused or stopped.
		...(runnersPaused() || !runnersRunning()
			? [{ label: runnersLine(), enabled: false }]
			: []),
		runnersItem(),
		{ type: "separator" },
		...updateItems(false),
		{ label: "Check this Mac…", click: checkThisMac },
		{ label: "Settings…", click: () => openSettings() },
		{ type: "separator" },
		{ label: "Quit Tedix", click: () => quitFrom("the menu bar icon") },
	]);
}

function createTray(): void {
	tray = new Tray(trayImage());
	tray.setToolTip("Tedix");
	bindTrayMenu(tray, openInputBar, trayMenu);
	openInputBar(true);
}

/**
 * The input bar: a small field near the top of the screen, like Spotlight.
 * What is typed there starts a new chat in the Tedix window.
 */
let inputBar: BrowserWindow | undefined;
/** When the bar last hid because it lost focus, so the icon's click does not reopen it. */
let inputBarBlurredAt = 0;
/** When the bar was last shown, to tell a real loss of focus from the one macOS causes as it appears. */
let inputBarShownAt = 0;

function placeInputBar(window: BrowserWindow): void {
	const { workArea } = screen.getDisplayNearestPoint(
		screen.getCursorScreenPoint(),
	);
	const { width } = window.getBounds();
	window.setPosition(
		workArea.x + Math.round((workArea.width - width) / 2),
		workArea.y + Math.round(workArea.height * 0.2),
	);
}

/**
 * Shows the input bar, or hides it when it is showing. `prepare` only
 * creates it, hidden, as the app starts, so the first click shows it at
 * once instead of after its page has loaded.
 */
function openInputBar(prepare = false): void {
	const existing = inputBar && !inputBar.isDestroyed() ? inputBar : undefined;
	if (prepare && existing) return;
	if (existing?.isVisible()) return existing.hide();
	if (existing && Date.now() - inputBarBlurredAt < 300) return;
	const show = (window: BrowserWindow) => {
		placeInputBar(window);
		inputBarShownAt = Date.now();
		app.focus({ steal: true });
		window.show();
		window.focus();
	};
	if (existing) return show(existing);
	const window = new BrowserWindow({
		width: 640,
		height: 60,
		show: false,
		frame: false,
		transparent: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		alwaysOnTop: true,
		title: "New chat",
		webPreferences: localPage,
	});
	inputBar = window;
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.on("blur", () => {
		// The first click finds Tedix in the background: bringing it forward
		// hands the keyboard to the main window a moment after the bar took
		// it, which closed the bar at once. That early loss gives it back.
		if (Date.now() - inputBarShownAt < 500) {
			setTimeout(() => {
				if (window.isDestroyed() || !window.isVisible()) return;
				window.focus();
			}, 50);
			return;
		}
		inputBarBlurredAt = Date.now();
		window.hide();
	});
	// Shown once its page is there, whichever of the two says so first.
	let shown = false;
	const first = () => {
		if (shown || window.isDestroyed()) return;
		shown = true;
		show(window);
	};
	if (!prepare) {
		window.once("ready-to-show", first);
		window.webContents.once("did-finish-load", first);
	}
	void window.loadFile(join(root, "input.html"));
}

/** Shows a Tedix OS page in the Tedix window, in the organization open now. */
async function openOsPage(path: string): Promise<void> {
	showMain();
	closeSettings();
	const view = os;
	if (!view || view.webContents.isDestroyed()) return;
	const current = URL.parse(view.webContents.getURL());
	const origin =
		current && isOsHost(current.host) ? current.origin : osOrigin();
	await view.webContents.loadURL(`${origin}${path}`).catch(() => {});
}

/**
 * Opens Get help in the Tedix window, filled in with what setup found on this
 * Mac. The person reviews it and approves before it is sent, and gets a
 * receipt there. Without a signed-in Tedix window, the details are copied and
 * Settings says what to do instead.
 */
async function getHelp(): Promise<void> {
	const report = setupState().report;
	const view = os;
	const copied = () => {
		clipboard.writeText(report.slice(0, 20_000));
		helpNote =
			appSignIn.state === "in"
				? "Tedix could not open Get help. The setup details are copied: in Tedix, open Get help and paste them."
				: "Sign in to Tedix to send this. The setup details are copied: after signing in, open Get help and paste them.";
	};
	if (appSignIn.state !== "in" || !view || view.webContents.isDestroyed()) {
		copied();
		return refresh();
	}
	showMain();
	// The form opens in the Tedix page, which Settings would cover.
	closeSettings();
	const prefill = {
		title: "An agent will not connect on this Mac",
		expected: "The agent connects to Tedix and can run tasks.",
		actual: report,
		page: "Mac app: Settings > Setup details",
	};
	const opened = await view.webContents
		.executeJavaScript(
			`(async (detail) => {
				for (let tries = 0; tries < 50; tries++) {
					const event = new CustomEvent("tedix:get-help", { detail });
					window.dispatchEvent(event);
					if (detail.handled) return true;
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
				return false;
			})(${JSON.stringify(prefill)})`,
		)
		.catch(() => false);
	log(
		`help: Get help ${opened ? "opened with the setup details" : "not opened; details copied"}`,
	);
	if (opened) helpNote = "";
	else copied();
	return refresh();
}

/**
 * Starts a new chat in the Tedix window with `text`: opens a new chat,
 * waits for its message field, fills it in and sends it. When the page
 * cannot send yet, the text stays in the field for the person to send.
 */
async function newChat(text: string): Promise<void> {
	inputBar?.hide();
	showMain();
	const view = os;
	if (!view || view.webContents.isDestroyed()) return;
	const current = URL.parse(view.webContents.getURL());
	const origin =
		current && isOsHost(current.host) ? current.origin : osOrigin();
	try {
		await view.webContents.loadURL(`${origin}/chat`);
	} catch {
		/* A redirect, such as to the sign-in, ends the load early. */
	}
	const outcome = await view.webContents
		.executeJavaScript(
			`(async (text) => {
				const wait = () => new Promise((resolve) => setTimeout(resolve, 200));
				for (let tries = 0; tries < 75; tries++) {
					if (location.pathname === "/login") return "sign-in";
					// The chat with a picked tedi and the workspace chat name their field differently.
					const field = document.querySelector('textarea[aria-label^="Message"]');
					if (field && !field.readOnly) {
						const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
						set.call(field, text);
						field.dispatchEvent(new Event("input", { bubbles: true }));
						field.focus();
						for (let waited = 0; waited < 25; waited++) {
							await wait();
							const send = field.closest("form")?.querySelector('button[type="submit"]');
							if (send && !send.disabled) {
								send.click();
								return "sent";
							}
						}
						return "filled";
					}
					await wait();
				}
				return "no message field";
			})(${JSON.stringify(text)})`,
		)
		.catch(() => "page error");
	log(`chat: new chat from the menu bar (${String(outcome)})`);
}

/**
 * Runs this Mac's runners as the app's child process. The first start on a
 * Mac that ran them with the CLI's login service removes that service and
 * opens Tedix at login instead, so the runners still start at login. A Mac
 * without runners starts them from Set up this Mac.
 */
/**
 * Tasks run only while Tedix is open, so a Mac that runs tasks opens Tedix at
 * login: switching an agent on for tasks turns Open at login on, and switching
 * off the last one turns it off again. Settings shows the result.
 */
function matchOpenAtLogin(): void {
	if (process.platform !== "darwin" || !app.isPackaged) return;
	const wanted = readRunners().some((entry) => entry.enabled);
	if (app.getLoginItemSettings().openAtLogin === wanted) return;
	app.setLoginItemSettings({ openAtLogin: wanted });
	log(
		`login: Open at login ${wanted ? "on: this Mac runs tasks" : "off: no agent runs tasks"}`,
	);
}

async function takeOverRunners(): Promise<void> {
	if (process.platform !== "darwin") return;
	const tookOver = await removeLoginService();
	if (tookOver && app.isPackaged && !app.getLoginItemSettings().openAtLogin) {
		app.setLoginItemSettings({ openAtLogin: true });
		log("start: Tedix opens at login now, in place of the login service");
	}
	status ??= await loadStatus();
	if (!tookOver && status.runners.length === 0) return;
	// Paused by the person: they stay stopped until Resume.
	if (runnersPaused()) return;
	const result = await startRunners();
	if (!result.ok) log(`runners: not started (${lastLine(result.output)})`);
	await refresh();
}

/**
 * True when macOS opened the app as the person logged in. macOS no longer
 * says so itself, so this goes by the Dock, which starts with the session:
 * with Open at Login on, a start in the Dock's first two minutes is the
 * one macOS made.
 */
async function openedAtLogin(): Promise<boolean> {
	if (process.platform !== "darwin" || !app.isPackaged) return false;
	if (!app.getLoginItemSettings().openAtLogin) return false;
	const dock = lastLine(
		(
			await run("/usr/bin/pgrep", [
				"-n",
				"-x",
				"-u",
				String(process.getuid?.()),
				"Dock",
			])
		).output,
	);
	if (!/^\d+$/.test(dock)) return false;
	const age = lastLine(
		(await run("/bin/ps", ["-o", "etime=", "-p", dock])).output,
	).trim();
	return /^0[01]:\d\d$/.test(age);
}

const appLink = (args: string[]) =>
	args.find((arg) => arg.startsWith("tedix://"));

if (!app.requestSingleInstanceLock()) app.quit();
else if (process.argv.includes("--local-model")) {
	void app.whenReady().then(() => {
		Menu.setApplicationMenu(
			Menu.buildFromTemplate([
				{ role: "appMenu" },
				{ role: "editMenu" },
				{ role: "windowMenu" },
			]),
		);
		app.on("activate", openLocalModelChat);
		app.on("second-instance", openLocalModelChat);
		app.on("window-all-closed", () => app.quit());
		openLocalModelChat();
	});
} else {
	if (app.isPackaged) app.setAsDefaultProtocolClient("tedix");
	// macOS hands a clicked link over here; other systems pass it as an argument.
	app.on("open-url", (event, url) => {
		event.preventDefault();
		openAppLink(url);
	});
	openAppLink(appLink(process.argv));
	// A page's "leave this page?" guard (an unsent draft, say). Electron
	// shows nothing and cancels the reload or quit silently, so Reload in
	// Tedix OS did nothing. A browser asks; so does the app. Quitting never
	// waits on it: that would leave the app running without runners.
	app.on("web-contents-created", (_event, contents) => {
		contents.on("will-prevent-unload", (event) => {
			if (quitting) return event.preventDefault();
			const options = {
				type: "question" as const,
				message: "Leave this page?",
				detail: "Changes you made may not be saved.",
				buttons: ["Leave", "Stay"],
				defaultId: 0,
				cancelId: 1,
			};
			const owner = BrowserWindow.fromWebContents(contents) ?? mainWindow;
			// A modal box on a window nobody sees blocks the menus, Quit
			// included, until it is answered: then the page just leaves.
			if (!owner || owner.isDestroyed() || !owner.isVisible()) {
				log("page: left a page that asked to stay, with no window shown");
				return event.preventDefault();
			}
			const answer = dialog.showMessageBoxSync(owner, options);
			if (answer === 0) event.preventDefault();
		});
	});
	void app.whenReady().then(async () => {
		log(`start: version ${app.getVersion()}`);
		applyAppearance(settings().appearance ?? "system");
		if (process.argv.some((arg) => arg.startsWith("--local")))
			openLocalTedix(process.argv);
		// Read and deleted before anything else: only a start that follows a
		// click on the update button may replace the command-line tool.
		const clicked = takeUpdateClick();
		restoring = clicked;
		// A wait for tasks does not outlive the app that chose it.
		rmSync(updateWaitingFile(), { force: true });
		setMenu();
		// Opened at login, Tedix starts in the menu bar without a window.
		const atLogin = await openedAtLogin();
		const first = firstRun();
		createMainWindow();
		void removeOldRuntimes();
		if (first) {
			log("start: first run; the setup opens first");
			openSetup();
		} else if (atLogin) app.dock?.hide();
		else {
			routingLaunch = true;
			void showLaunchWindow().finally(() => {
				routingLaunch = false;
			});
		}
		createTray();
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
				// Switching a tool off stops its tasks: ask first.
				const runner = status?.runners.find((row) => row.index === index);
				const runs =
					status?.activeTasks.filter(
						(task) => task.executor === runner?.executor,
					).length ?? 0;
				if (
					key === "enabled" &&
					value === false &&
					!(await agreeToStop("Switch off", runs))
				)
					return refresh();
				try {
					setRunnerField(index, key, value);
				} catch (error) {
					lastOutput = error instanceof Error ? error.message : String(error);
					log(`runners: ${key} for runner ${index} not saved: ${lastOutput}`);
					return refresh();
				}
				if (key === "enabled") matchOpenAtLogin();
				// The supervisor reads the file on its next check and starts or
				// stops only this runner; machine tools pick up a new name or
				// write setting once idle. Nothing else restarts.
				lastOutput = "";
				await startRunnersIfStopped();
				await refresh();
			},
		);
		ipcMain.handle("action", (event, name: PanelAction) => {
			const asking = fromLocalPage(event);
			if (name === "save-claude-plugin") return saveClaudePlugin(asking);
			if (name === "get-help") return getHelp();
			if (name === "restart") return restartRunners(true);
			if (name === "pause") return pauseAsked();
			if (name === "cli-back") return void goBackCli();
			if (name === "setup-window") return openSetup();
			if (name === "check-updates") return checkForUpdates(true, true);
			if (name === "apply-update") return applyUpdate();
			const returnToSetup = () => {
				if (quitting) return;
				localChosen = false;
				openSetup();
			};
			if (name === "local-workspace") return openLocalTedix([], returnToSetup);
			if (name === "start-local-workspace") {
				if (
					event.sender !== setupWindow?.webContents ||
					!bundledLocalAvailable()
				)
					return;
				// Trying it on this Mac: the Cloud window waits until asked for.
				localChosen = true;
				openLocalTedix([], returnToSetup);
				setupWindow.close();
				return;
			}
			if (name === "local-model") return openLocalModelChat();
			if (name === "open-logs") return void shell.openPath(configDir());
			if (name === "close-settings") return closeSettings();
			if (name === "open-routing") {
				const file = setupState().routing?.file;
				if (file) return void shell.openPath(file);
			}
			if (name === "close-setup" || name === "done-setup") {
				setupWindow?.close();
				if (name === "done-setup") return;
				showMain();
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
					log("sign-in: chosen in Set up this Mac or Settings");
					return signIn();
				},
				openSignIn: (url) => shell.openExternal(url),
				// Called once an agent was switched on for tasks.
				startRunnersIfStopped: async () => {
					matchOpenAtLogin();
					await startRunnersIfStopped();
				},
				confirmRemove: async (name) =>
					(
						await dialog.showMessageBox(asking, {
							type: "question",
							message: `Remove Tedix from ${name}?`,
							detail: `${name} is signed out of Tedix, and the Tedix plugin, hooks and connection are taken out of it. ${name} stops running Tedix tasks on this Mac. ${name} itself, its account and your other settings stay. You can choose Connect again at any time.`,
							buttons: ["Remove", "Cancel"],
							defaultId: 1,
							cancelId: 1,
						})
					).response === 0,
				tasksChanged: matchOpenAtLogin,
			});
			await refresh();
		});
		ipcMain.handle("copy", (event, text: unknown) => {
			fromLocalPage(event);
			if (typeof text === "string") clipboard.writeText(text.slice(0, 20_000));
		});
		ipcMain.handle("open", async (event, link: PanelLink) => {
			fromLocalPage(event);
			if (Object.hasOwn(APP_LINKS, link)) {
				const desktop = APP_LINKS[link as keyof typeof APP_LINKS];
				const path = desktopAppPath(desktop);
				const failure = path
					? await shell.openPath(path)
					: "The app was not found.";
				if (failure)
					await dialog.showMessageBox({
						type: "warning",
						message: "Could not open the app",
						detail: failure,
					});
				return;
			}
			if (Object.hasOwn(PANEL_LINKS, link))
				await shell.openExternal(PANEL_LINKS[link as keyof typeof PANEL_LINKS]);
		});
		ipcMain.handle("open-work", (event, itemId: unknown) => {
			fromLocalPage(event);
			if (typeof itemId === "string" && /^[0-9a-f-]{36}$/.test(itemId))
				void openOsPage(`/work/items/${itemId}`);
		});
		// Only the update entry's own page may ask for an update.
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
		// Only the question window may answer the question.
		const fromQuestion = (event: { sender: Electron.WebContents }) =>
			event.sender === question?.window.webContents;
		ipcMain.on("question-ready", (event) => {
			if (fromQuestion(event)) event.sender.send("question", question?.view);
		});
		ipcMain.handle("question-size", (event, height: number) => {
			if (!fromQuestion(event) || !question) throw new Error("Not allowed");
			const { window } = question;
			window.setContentSize(
				420,
				Math.max(72, Math.min(Number(height) || 0, 640)),
			);
			app.focus({ steal: true });
			window.show();
			window.focus();
		});
		ipcMain.handle(
			"question-answer",
			(event, response: number, checked: boolean) => {
				if (!fromQuestion(event) || !question) throw new Error("Not allowed");
				const { view, settle } = question;
				settle({
					response:
						Number.isInteger(response) &&
						response >= 0 &&
						response < view.buttons.length
							? response
							: view.cancelId,
					checkboxChecked: checked === true,
				});
			},
		);
		ipcMain.handle("restart-runner", (event, index: unknown) => {
			fromLocalPage(event);
			if (Number.isInteger(index)) return restartRunner(index as number);
		});
		ipcMain.handle("appearance", (event, mode: unknown) => {
			fromLocalPage(event);
			if (mode !== "system" && mode !== "light" && mode !== "dark") return;
			saveSettings({ appearance: mode });
			applyAppearance(mode);
			return publish();
		});
		ipcMain.handle("open-at-login", (event, on: boolean) => {
			fromLocalPage(event);
			app.setLoginItemSettings({ openAtLogin: on === true });
			return publish();
		});

		app.on("second-instance", (_event, args) => {
			if (args.includes("--local-model")) return openLocalModelChat();
			// `open -na Tedix.app --args --local`: the Local Tedix window of this app.
			if (args.some((arg) => arg.startsWith("--local")))
				return openLocalTedix(args);
			showMain();
			openAppLink(appLink(args));
		});
		// Only the input bar may start a chat from it.
		const fromInputBar = (event: { sender: Electron.WebContents }) =>
			event.sender === inputBar?.webContents;
		ipcMain.handle("new-chat", (event, text: unknown) => {
			if (!fromInputBar(event)) throw new Error("Not allowed");
			if (typeof text === "string" && text.trim())
				return newChat(text.trim().slice(0, 20_000));
		});
		ipcMain.handle("open-local-chat", (event) => {
			if (!fromInputBar(event)) throw new Error("Not allowed");
			inputBar?.hide();
			openLocalModelChat();
		});
		ipcMain.handle("input-close", (event) => {
			if (!fromInputBar(event)) throw new Error("Not allowed");
			inputBar?.hide();
		});
		// Tedix stays in the menu bar with no window open; only Quit ends it.
		app.on("window-all-closed", () => {});
		// While the first-run setup is open, it stays in front of the Tedix window.
		app.on("activate", () => {
			if (routingLaunch || localChosen) return;
			if (setupWindow && !setupWindow.isDestroyed()) return setupWindow.show();
			if (appSignIn.state === "out" && !mainWindow?.isVisible())
				return openSetup();
			showMain();
		});
		process.on("SIGTERM", () => quitFrom("a TERM signal"));
		powerMonitor.on("on-battery", () => void publish());
		powerMonitor.on("on-ac", () => void publish());
		powerMonitor.on("shutdown", () => {
			quitSource = "macOS shutting down";
		});
		// Quitting stops this Mac's runners first: they are this app's child.
		app.on("before-quit", (event) => {
			const byHand = ![
				"an update",
				"a TERM signal",
				"macOS shutting down",
			].includes(quitSource);
			if (!quitting && byHand && !quitAgreed && (status?.activeRuns ?? 0) > 0) {
				event.preventDefault();
				return void askToQuit();
			}
			if (!quitting) log(`quit: asked by ${quitSource}`);
			quitting = true;
			// A downloaded update installs on the way out, like Goose and
			// Sparkle; the next start is the new version. Not when macOS shuts
			// down or the app is signalled: the swap could be cut off midway.
			if (byHand && readyVersion() && !installingOnQuit) {
				installingOnQuit = true;
				event.preventDefault();
				void restartToUpdate(false)
					.catch((error: Error) =>
						log(`update: not installed on quit (${error.message})`),
					)
					.finally(() => app.quit());
				return;
			}
			if (!runnersRunning()) {
				exitSoon();
				return void stopRunners();
			}
			event.preventDefault();
			log("quit: stopping this Mac's runners first");
			void stopRunners().finally(async () => {
				log("quit: runners stopped");
				exitSoon();
				// A question answered a moment ago is still closing its window;
				// the quit waits for that, briefly, rather than run into it.
				await Promise.race([
					questionClosing,
					new Promise((resolve) => setTimeout(resolve, 1000)),
				]);
				log("quit: closing the app");
				app.quit();
			});
		});
		// Each step of a quit is logged, so a stall shows where it stopped.
		app.on("window-all-closed", () => {
			if (quitting) log("quit: windows closed");
		});
		app.on("will-quit", () => {
			if (quitting) log("quit: about to exit");
		});
		app.on("quit", () => log("quit: exited"));
		onRunnersChange(() => void refresh());
		setInterval(() => {
			void refresh();
			// While a browser sign-in is waiting, notice when it ends.
			if (appSignIn.waiting) void readAppSignIn();
		}, 5000);
		setInterval(() => void refreshSetup(false).then(readAgentStatus), 60_000);
		onSetupChange(() => void publish());
		onCliChange(() => void refreshSetup(false).then(refresh));
		void refreshSetup(true).then(async () => {
			// The second half of the click that restarted the app. It runs
			// before the runners start, so they start on the new tool.
			if (clicked) {
				log("update: this start follows a click to update");
				await working("Updating…", async () => {
					await lookForCliUpdate(false);
					await refreshSetup(false);
					await applyCommandLineTool(true);
				});
				if (!failure && clicked.from && isNewer(app.getVersion(), clicked.from))
					void sayUpdated();
			}
			await takeOverRunners();
		});
		// The app and the command-line tool have their own releases. By itself
		// the app at most asks, downloads a newer app and reads which
		// command-line tool is published; applying either takes a click.
		setTimeout(() => void checkForUpdates(false), 10_000);
		setInterval(() => void checkForUpdates(false), 60 * 60_000);
		void refresh();
	});
}
