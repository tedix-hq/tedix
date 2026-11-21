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
	Notification,
	nativeImage,
	nativeTheme,
	type Rectangle,
	screen,
	shell,
	Tray,
	WebContentsView,
} from "electron";
import type {
	DownloadView,
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
	supervisorLoaded,
	takeUpdateClick,
	updateCli,
} from "./cli";
import { log } from "./log";
import {
	onRunnersChange,
	removeLoginService,
	runnersProblem,
	runnersRunning,
	startRunners,
	stopRunners,
} from "./runners";
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
import { activeRunCount, loadStatus, type Status, summary } from "./status";
import {
	cancelDownload,
	downloadProgress,
	downloadUpdate,
	type FoundUpdate,
	findUpdate,
	readyVersion,
	restartToUpdate,
} from "./update";

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
	status ??= await loadStatus();
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

/** Stops the runners this app runs and starts them again. */
async function restartRunners(): Promise<void> {
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
 * in use. A click on it, or on Install Update, is the only thing that
 * applies either.
 */
let updateButton: WebContentsView | undefined;
/** How much room the entry's page asked for. */
let updateSize = { width: 0, height: 0 };
let applying: string | undefined;
let failure: string | undefined;
/** The person chose to update once the tasks on this Mac have finished. */
let waitingForWork = false;
let pageDark = nativeTheme.shouldUseDarkColors;
let layoutMain = () => {};
/** A newer published app, found by the last check, maybe not downloaded yet. */
let found: FoundUpdate | undefined;
let downloadWindow: BrowserWindow | undefined;
/** Why the last download shown in the window stopped. */
let downloadEnded: string | undefined;
/** An update question is open, so a background check does not ask again. */
let asking = false;
/** Where the Tedix OS page's sidebar footer is, in the view's pixels. */
let sidebarSpot: { x: number; y: number; width: number; rail: boolean } | null =
	null;

/** A newer command-line tool, when `~/.local/bin/tedix` is the app's copy. */
function cliOffer(): string | undefined {
	const { kind, offer } = setupState().cli;
	return kind === "included" ? offer : undefined;
}

/** What the entry offers: skipped command-line tool versions only on a click. */
function offers(): { app?: string; cli?: string } {
	const cli = cliOffer();
	return {
		app: readyVersion(),
		cli: cli && settings().skipped?.cli !== cli ? cli : undefined,
	};
}

function updateView(): UpdateView {
	const dark = pageDark;
	const place = !sidebarSpot ? "corner" : sidebarSpot.rail ? "rail" : "sidebar";
	const view = { dark, place } as const;
	if (applying) {
		const step = cliProgress().updating ?? "";
		const text = step.startsWith("Downloading")
			? "Downloading…"
			: /^(Restarting|Waiting)/.test(step)
				? "Restarting runners…"
				: applying;
		return { ...view, kind: "working", text, label: text };
	}
	if (failure)
		return {
			...view,
			kind: "failed",
			text: "Update did not finish",
			label: "Update did not finish. Show why",
		};
	const { app: appVersion, cli } = offers();
	if (!appVersion && !cli)
		return { ...view, kind: "hidden", text: "", label: "" };
	if (waitingForWork)
		return {
			...view,
			kind: "waiting",
			text: "Updates when work is done",
			label:
				"Updates by itself when the tasks on this Mac have finished. Choose to update now or not now",
		};
	return {
		...view,
		kind: "ready",
		text: appVersion ? "Relaunch to update" : "Update command-line tool",
		label: appVersion
			? cli
				? `Relaunch to update to Tedix ${appVersion} and command-line tool ${cli}`
				: `Relaunch to update to Tedix ${appVersion}`
			: `Update the command-line tool to ${cli}`,
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
	if (!shown) return;
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

function publishUpdate(): void {
	const contents = updateButton?.webContents;
	if (contents && !contents.isDestroyed())
		contents.send("update", updateView());
	layoutMain();
	if (waitingForWork) watchWork();
}

/** Says what is in use now, in a notification. */
function sayDone(line: string): void {
	log(`update: ${line}`);
	if (Notification.isSupported())
		new Notification({ title: "Tedix is up to date", body: line }).show();
}

/**
 * Puts the newest command-line tool in place and reloads the background
 * service. Only ever reached from the person's click on the update entry or
 * Install Update: directly, or on the start that follows it (see
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
			cliProgress().reloadedAt >= from
				? ` Runners restarted. ${FOLDER_PROMPT}`
				: ""
		}`,
	);
}

const FOLDER_PROMPT =
	"If macOS asks whether Tedix may use your Documents folder, choose Allow.";

/** Runs one of the entry's jobs and shows how it ended. */
async function working(text: string, job: () => Promise<void>): Promise<void> {
	if (applying) return;
	applying = text;
	failure = undefined;
	waitingForWork = false;
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
			noteUpdateClick();
			restartToUpdate();
			// The app quits now; the entry keeps saying so until it does.
			return new Promise(() => {});
		}
		await applyCommandLineTool(false);
	});
}

/** While the person waits for the work on this Mac to finish: checks every 15 seconds. */
let workWatch: ReturnType<typeof setInterval> | undefined;
function watchWork(): void {
	workWatch ??= setInterval(async () => {
		if (!waitingForWork || updateView().kind === "hidden") {
			clearInterval(workWatch);
			workWatch = undefined;
			waitingForWork = false;
			return;
		}
		if ((await activeRunCount()) > 0) return;
		clearInterval(workWatch);
		workWatch = undefined;
		log("update: the work on this Mac has finished; updating as chosen");
		void updateNow();
	}, 15_000);
}

/** A free-standing native dialog, so every button is a real, reachable button. */
async function ask(
	options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
	await app.whenReady();
	app.focus({ steal: true });
	return dialog.showMessageBox(options);
}

/**
 * The click on the update entry, or Install Update. When applying it
 * restarts this Mac's runners while tasks run there, one dialog says how
 * many and lets the person choose: not now, once the work is done, or now.
 */
async function applyUpdate(): Promise<void> {
	if (applying) return;
	if (failure) {
		const down = cliProgress().last?.down;
		const { response } = await ask({
			type: "warning",
			message: "The update did not finish",
			detail: failure,
			buttons: [down ? "Restart Runners" : "Try Again", "Close"],
			defaultId: 0,
			cancelId: 1,
		});
		failure = undefined;
		publishUpdate();
		if (response !== 0) return;
		if (down)
			return working("Restarting runners…", async () => {
				const result = await restartSupervisor();
				if (!result.ok)
					throw new Error(
						`The runners did not start: ${lastLine(result.output) || "no reason given"}.`,
					);
				sayDone("Runners restarted.");
			});
	}
	const appVersion = readyVersion();
	const cli = cliOffer();
	if (!appVersion && !cli) {
		if (found) await installUpdate();
		return;
	}
	// The runners are this app's child process: a relaunch restarts them too.
	const restartsRunners =
		(Boolean(cli) || Boolean(appVersion)) && (await supervisorLoaded());
	const runs = restartsRunners ? await activeRunCount() : 0;
	if (runs === 0) return updateNow();

	status ??= await loadStatus();
	const runners = status.runners.filter(
		(runner) => runner.enabled && runner.running,
	).length;
	const tasks = runs === 1 ? "1 task is" : `${runs} tasks are`;
	const { response } = await ask({
		type: "warning",
		message: "Tasks are still running on this Mac",
		detail: [
			appVersion
				? cli
					? "An update for the app and the command-line tool is ready."
					: "An update for the app is ready."
				: "An update for the command-line tool is ready.",
			`${tasks} running on this Mac. Updating restarts ${
				runners
					? `this Mac's ${runners} ${runners === 1 ? "runner" : "runners"}`
					: "this Mac's runners"
			}, which stops ${runs === 1 ? "that task" : "these tasks"}.`,
			appVersion ? "Tedix also relaunches." : "",
			FOLDER_PROMPT,
		]
			.filter(Boolean)
			.join("\n\n"),
		buttons: ["Update When Work Is Done", "Update Now", "Not Now"],
		defaultId: 0,
		cancelId: 2,
	});
	if (response === 1) return updateNow();
	waitingForWork = response === 0;
	log(
		waitingForWork
			? `update: waiting for ${runs} running tasks to finish`
			: "update: not now",
	);
	publishUpdate();
}

/** The downloading window: the Tedix icon, a progress bar, and Cancel. */
function downloadView(): DownloadView {
	const progress = downloadProgress();
	return {
		version: progress?.version ?? found?.version ?? "",
		received: progress?.received ?? 0,
		total: progress?.total ?? found?.size ?? 0,
		ended: downloadEnded,
	};
}

function publishDownload(): void {
	const contents = downloadWindow?.webContents;
	if (contents && !contents.isDestroyed())
		contents.send("download", downloadView());
}

function openDownloadWindow(): void {
	void app.dock?.show();
	if (downloadWindow && !downloadWindow.isDestroyed())
		return downloadWindow.show();
	const window = new BrowserWindow({
		width: 440,
		height: 136,
		title: "Updating Tedix",
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		backgroundColor: windowColour(),
		webPreferences: localPage,
	});
	downloadWindow = window;
	window.setMenuBarVisibility(false);
	window.webContents.on("will-navigate", (event) => event.preventDefault());
	window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	// Closing the window is the same as Cancel.
	window.on("closed", () => {
		if (downloadWindow === window) downloadWindow = undefined;
		if (!downloadEnded) cancelDownload();
		updateDock();
	});
	void window.loadFile(join(root, "download.html"));
}

/** Downloads and checks the found app; `show` opens the downloading window. */
async function download(show: boolean): Promise<boolean> {
	if (!found) return false;
	downloadEnded = undefined;
	if (show) openDownloadWindow();
	try {
		await downloadUpdate(found, () => {
			publishDownload();
		});
		downloadEnded = "";
		downloadWindow?.close();
		publishUpdate();
		return true;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if ((error as Error).name === "AbortError") {
			downloadEnded = "Cancelled";
			downloadWindow?.close();
		} else {
			downloadEnded = reason;
			log(`update: download failed (${reason})`);
			publishDownload();
		}
		return false;
	}
}

/** Install Update: downloads the app with the window, then applies like the entry. */
async function installUpdate(): Promise<void> {
	saveSettings({ skipped: {} });
	if (found && readyVersion() !== found.version && !(await download(true)))
		return;
	await refreshSetup(false);
	await applyUpdate();
}

/**
 * The update question: both version numbers, Install Update, Remind Me
 * Later, Skip This Version, and whether to download by itself from now on.
 */
async function askToUpdate(appVersion?: string, cli?: string): Promise<void> {
	asking = true;
	const have = setupState().cli.version;
	const lines = [
		appVersion &&
			`Tedix ${appVersion} is now available. You have ${app.getVersion()}.`,
		cli &&
			`Command-line tool ${cli} is now available${have ? `. You have ${have}` : ""}.`,
		cli &&
			`Updating the command-line tool restarts this Mac's runners. ${FOLDER_PROMPT}`,
		!cli && appVersion && "Updating the app restarts this Mac's runners.",
		appVersion && readyVersion() === appVersion
			? "It is downloaded and ready. Would you like to install it now?"
			: "Would you like to download and install it now?",
	].filter(Boolean);
	let choice: Electron.MessageBoxReturnValue;
	try {
		choice = await ask({
			type: "info",
			message: appVersion
				? "A new version of Tedix is available"
				: "A new command-line tool is available",
			detail: lines.join("\n\n"),
			buttons: ["Install Update", "Remind Me Later", "Skip This Version"],
			defaultId: 0,
			cancelId: 1,
			checkboxLabel: "Download updates automatically",
			checkboxChecked: settings().autoDownload === true,
		});
	} finally {
		asking = false;
	}
	const { response, checkboxChecked } = choice;
	saveSettings({ autoDownload: checkboxChecked });
	log(
		`update: question answered (${["install", "remind later", "skip"][response]}, download automatically ${checkboxChecked ? "on" : "off"})`,
	);
	if (response === 0) return installUpdate();
	if (response === 1) {
		saveSettings({ remindAfter: Date.now() + 24 * 60 * 60_000 });
		if (checkboxChecked && appVersion && found) void download(false);
	}
	if (response === 2) {
		saveSettings({ skipped: { app: appVersion, cli } });
		publishUpdate();
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
	showMain();
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
/**
 * The main window's size and place, kept in the app's data folder (each copy
 * has its own, so the copy run from source never moves the installed one).
 */
const windowFile = () => join(app.getPath("userData"), "window.json");

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

/** Shows the main window and puts Tedix back in the Dock. */
function showMain(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	void app.dock?.show();
	window.show();
	window.focus();
}

/** Without a visible window, Tedix lives in the menu bar only. */
function updateDock(): void {
	if (process.platform !== "darwin" || quitting) return;
	const shown = [mainWindow, panel, setupWindow, downloadWindow].some(
		(window) => window && !window.isDestroyed() && window.isVisible(),
	);
	if (!shown) app.dock?.hide();
}

function createMainWindow(show: boolean): void {
	const window = new BrowserWindow({
		...(savedBounds() ?? defaultBounds()),
		show,
		minWidth: 720,
		minHeight: 520,
		title: "Tedix",
		titleBarStyle: "hiddenInset",
		// Centres the buttons in the page's 56 px top bar.
		trafficLightPosition: { x: 20, y: 20 },
		backgroundColor: "#0a0a0a",
	});
	mainWindow = window;
	// Closing the window leaves Tedix in the menu bar, with its runners;
	// only Quit ends the app.
	window.on("close", (event) => {
		try {
			writeFileSync(windowFile(), JSON.stringify(window.getNormalBounds()));
		} catch (error) {
			log(`window: size not kept (${(error as Error).message})`);
		}
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
		const { kind, place } = updateView();
		const shown = kind !== "hidden" && updateSize.width > 0;
		button.setVisible(shown);
		if (!shown) return;
		const entry = 32;
		const spot = sidebarSpot;
		button.setBounds(
			place === "corner" || !spot
				? {
						x: 12,
						y: height - 12 - entry,
						width: Math.min(updateSize.width, width - 24),
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
	setInterval(() => void findSidebar(), 1000);

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
	void view.webContents.loadURL(`${osOrigin()}/chat`);
	view.webContents.focus();
}

/** The background of the app's own two windows, so they do not flash while loading. */
const windowColour = () =>
	nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#fafafa";

/** The small This Mac window: status and the day-to-day switches. */
function openPanel(): void {
	void app.dock?.show();
	if (panel && !panel.isDestroyed()) return panel.show();
	panel = new BrowserWindow({
		width: 400,
		height: 640,
		title: "This Mac",
		backgroundColor: windowColour(),
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		webPreferences: localPage,
	});
	panel.setMenuBarVisibility(false);
	panel.on("closed", updateDock);
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
	window.on("closed", updateDock);
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
 * Looks for a newer app and a newer command-line tool; it applies nothing.
 * `asked` is true when the person chose Check for Updates…: then it always
 * answers, also for a skipped version. By itself it asks only about a newer
 * app that was not skipped, at most once a day after Remind Me Later, and
 * with Download updates automatically on it only downloads; a newer
 * command-line tool by itself only brings up the update entry.
 */
async function checkForUpdates(asked: boolean): Promise<void> {
	let problem = "";
	try {
		const result = await findUpdate();
		if (result.kind === "unavailable") problem = result.reason;
		found = result.kind === "found" ? result.update : undefined;
	} catch (error) {
		problem = `Could not check for a newer app: ${error instanceof Error ? error.message : String(error)}. Try again later.`;
		log(`update: ${problem}`);
	}
	await lookForCliUpdate(asked);
	await refreshSetup(false);
	publishUpdate();
	const appVersion = found?.version;
	const cli = cliOffer();
	if (asked) {
		if (appVersion || cli) return askToUpdate(appVersion, cli);
		const { version } = setupState().cli;
		await ask({
			type: "info",
			message: `You're up to date (version ${app.getVersion()})`,
			detail: [
				`Tedix ${app.getVersion()}${version ? ` and command-line tool ${version} are the newest versions` : " is the newest version"}.`,
				problem,
			]
				.filter(Boolean)
				.join(" "),
			buttons: ["OK"],
		});
		return;
	}
	const { autoDownload, skipped, remindAfter } = settings();
	if (!appVersion || skipped?.app === appVersion) return;
	if (autoDownload) {
		if (readyVersion() !== appVersion) void download(false);
		return;
	}
	if (asking || readyVersion() === appVersion) return;
	if (remindAfter && remindAfter > Date.now()) return;
	await askToUpdate(appVersion, cli);
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

/**
 * The menu bar icon, drawn here as a template image so macOS colours it
 * for light and dark menu bars: a rounded square with a T in it.
 */
function trayImage(): Electron.NativeImage {
	const size = 36;
	const inRoundedSquare = (x: number, y: number, from: number, r: number) => {
		const to = size - from;
		const dx = Math.max(from + r - x, 0, x - (to - r));
		const dy = Math.max(from + r - y, 0, y - (to - r));
		return (
			x >= from && x <= to && y >= from && y <= to && dx * dx + dy * dy <= r * r
		);
	};
	const ink = (x: number, y: number) =>
		(inRoundedSquare(x, y, 3, 8) && !inRoundedSquare(x, y, 6, 5)) ||
		(x >= 11 && x <= 25 && y >= 11 && y <= 14.5) ||
		(x >= 16.25 && x <= 19.75 && y >= 11 && y <= 26);
	const pixels = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++) {
			let covered = 0;
			for (let sy = 0; sy < 4; sy++)
				for (let sx = 0; sx < 4; sx++)
					if (ink(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) covered++;
			pixels[(y * size + x) * 4 + 3] = Math.round((covered / 16) * 255);
		}
	const image = nativeImage.createFromBitmap(pixels, {
		width: size,
		height: size,
		scaleFactor: 2,
	});
	image.setTemplateImage(true);
	return image;
}

/** One line on this Mac's runners for the menu bar menu. */
function runnersLine(): string {
	const problem = runnersProblem();
	if (problem)
		return problem.length > 90 ? `${problem.slice(0, 89)}…` : problem;
	if (!runnersRunning()) return "This Mac's runners are not running";
	const enabled = status?.runners.filter((runner) => runner.enabled) ?? [];
	const running = enabled.filter((runner) => runner.running).length;
	const runs = status?.activeRuns ?? 0;
	return `Runners: ${running} of ${enabled.length} running · ${runs} ${runs === 1 ? "task" : "tasks"}`;
}

let tray: Tray | undefined;

/** Right click on the menu bar icon. */
function trayMenu(): Menu {
	return Menu.buildFromTemplate([
		{ label: "Open Tedix", click: showMain },
		{ label: "New Chat…", click: openInputBar },
		{ type: "separator" },
		{ label: runnersLine(), enabled: false },
		{ label: "This Mac…", click: openPanel },
		{ label: "Restart Runners", click: () => void restartRunners() },
		{ type: "separator" },
		{ label: "Check for Updates…", click: () => void checkForUpdates(true) },
		...(app.isPackaged
			? [
					{
						label: "Open at Login",
						type: "checkbox" as const,
						checked: app.getLoginItemSettings().openAtLogin,
						click: (item: Electron.MenuItem) => {
							app.setLoginItemSettings({ openAtLogin: item.checked });
							void publish();
						},
					},
				]
			: []),
		{ type: "separator" },
		{ label: "Quit Tedix and Stop Runners", click: () => app.quit() },
	]);
}

function createTray(): void {
	tray = new Tray(trayImage());
	tray.setToolTip("Tedix");
	// Left click opens the input bar; right click (or Control-click) the menu.
	tray.on("click", (event) => {
		if (event.ctrlKey) return tray?.popUpContextMenu(trayMenu());
		openInputBar();
	});
	tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));
}

/**
 * The input bar: a small field near the top of the screen, like Spotlight.
 * What is typed there starts a new chat in the Tedix window.
 */
let inputBar: BrowserWindow | undefined;
/** When the bar last hid because it lost focus, so the icon's click does not reopen it. */
let inputBarBlurredAt = 0;

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

function openInputBar(): void {
	const existing = inputBar && !inputBar.isDestroyed() ? inputBar : undefined;
	if (existing?.isVisible()) return existing.hide();
	if (existing && Date.now() - inputBarBlurredAt < 300) return;
	const show = (window: BrowserWindow) => {
		placeInputBar(window);
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
		inputBarBlurredAt = Date.now();
		window.hide();
	});
	window.once("ready-to-show", () => show(window));
	void window.loadFile(join(root, "input.html"));
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
					const field = document.querySelector('textarea[aria-label="Message"]');
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
async function takeOverRunners(): Promise<void> {
	if (process.platform !== "darwin") return;
	const tookOver = await removeLoginService();
	if (tookOver && app.isPackaged && !app.getLoginItemSettings().openAtLogin) {
		app.setLoginItemSettings({ openAtLogin: true });
		log("start: Tedix opens at login now, in place of the login service");
	}
	status ??= await loadStatus();
	if (!tookOver && status.runners.length === 0) return;
	const result = await startRunners();
	if (!result.ok) log(`runners: not started (${lastLine(result.output)})`);
	await refresh();
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
		// Opened at login, Tedix starts in the menu bar without a window.
		const atLogin =
			process.platform === "darwin" &&
			app.getLoginItemSettings().wasOpenedAtLogin;
		createMainWindow(!atLogin);
		if (atLogin) app.dock?.hide();
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
		// Only the downloading window may cancel the download.
		const fromDownloadWindow = (event: { sender: Electron.WebContents }) =>
			event.sender === downloadWindow?.webContents;
		ipcMain.handle("download-cancel", (event) => {
			if (!fromDownloadWindow(event)) throw new Error("Not allowed");
			cancelDownload();
		});
		ipcMain.on("download-ready", (event) => {
			if (fromDownloadWindow(event)) publishDownload();
		});
		ipcMain.handle("open-at-login", (event, on: boolean) => {
			fromLocalPage(event);
			app.setLoginItemSettings({ openAtLogin: on === true });
			return publish();
		});

		app.on("second-instance", (_event, args) => {
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
		ipcMain.handle("input-close", (event) => {
			if (!fromInputBar(event)) throw new Error("Not allowed");
			inputBar?.hide();
		});
		// Tedix stays in the menu bar with no window open; only Quit ends it.
		app.on("window-all-closed", () => {});
		app.on("activate", showMain);
		// Quitting stops this Mac's runners first: they are this app's child.
		app.on("before-quit", (event) => {
			quitting = true;
			if (!runnersRunning()) return void stopRunners();
			event.preventDefault();
			log("quit: stopping this Mac's runners first");
			void stopRunners().finally(() => app.quit());
		});
		onRunnersChange(() => void refresh());
		setInterval(() => {
			void refresh();
			// While a browser sign-in is waiting, notice when it ends.
			if (appSignIn.waiting) void readAppSignIn();
		}, 5000);
		// The checklist opens by itself while the command-line tool or the
		// sign-in on this Mac is still to do.
		onSetupChange(() => void publish());
		onCliChange(() => void refreshSetup(false).then(refresh));
		void refreshSetup(true).then(async () => {
			if (setupState().open) openSetup();
			// The second half of the click that restarted the app. It runs
			// before the runners start, so they start on the new tool.
			if (clicked) {
				log("update: this start follows a click to update");
				await working("Updating…", async () => {
					await lookForCliUpdate(false);
					await refreshSetup(false);
					await applyCommandLineTool(true);
				});
			}
			await takeOverRunners();
		});
		// The app and the command-line tool have their own releases. By itself
		// the app at most asks, downloads a newer app and reads which
		// command-line tool is published; applying either takes a click.
		setTimeout(() => void checkForUpdates(false), 10_000);
		setInterval(() => void checkForUpdates(false), 4 * 60 * 60_000);
		void refresh();
	});
}
