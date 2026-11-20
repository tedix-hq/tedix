import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	linkSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, Notification } from "electron";
import { log } from "./log";
import {
	configDir,
	lastLine,
	localBin,
	loginShell,
	run,
	shellHasLocalBin,
} from "./shell";
import { isNewer } from "./update";

/**
 * The command-line tool that ships inside the app. The app copies it to one
 * fixed place in its own data folder and links `~/.local/bin/tedix` to that
 * copy. The place does not change between versions, because macOS remembers
 * a program's folder permissions by where the program is.
 */
const link = join(localBin, "tedix");
/** A separately installed tool, kept here while the app's copy is linked. */
const kept = `${link}.before-app`;
/** Tells the CLI that the file beside it is the app's copy. */
const MARKER = "managed-by-tedix-app";
const SUPERVISOR = "dev.tedix.supervisor";
/** Where published command-line tools come from; nothing else is accepted. */
const DOWNLOADS = "https://downloads.tedix.dev";

const stagedFolder = () => join(app.getPath("userData"), "cli");
const staged = () => join(stagedFolder(), "tedix");
/**
 * The app's other copy: the one in use before the last update or go back.
 * The person can swap the two with "Go back to version Y".
 */
const other = () => `${staged()}.other-app`;

/** The copy inside the app, or the one `scripts/fetch-cli.ts` fetched for a run from source. */
function bundled(): string | undefined {
	const path = app.isPackaged
		? join(process.resourcesPath, "cli", "tedix")
		: join(app.getAppPath(), "cli", process.arch, "tedix");
	return existsSync(path) ? path : undefined;
}

async function versionOf(path: string): Promise<string> {
	const result = await run(path, ["--version"], { timeoutMs: 20_000 });
	const version = lastLine(result.output);
	return result.ok && /^\d+\.\d+\.\d+/.test(version) ? version : "";
}

export interface CliState {
	/**
	 * `included`: `~/.local/bin/tedix` is the app's copy. `separate`: another
	 * install is there and the app has a copy it could link instead.
	 * `own`: this app has no copy inside (run from source). `missing`: no tool.
	 */
	kind: "included" | "separate" | "own" | "missing";
	version: string;
	/** A separate install is kept and can be put back. */
	canRestore: boolean;
	problem?: string;
	/** A newer version the person can choose to update to. */
	offer?: string;
	/** The version of the kept copy the person can go back to. */
	other?: string;
	/** How the last look, update or go back ended, and when. */
	update?: {
		ok: boolean;
		text: string;
		at: number;
		/** After a restart the person chose, the service or every runner stayed down. */
		down?: boolean;
	};
	/** What the app is doing to the command-line tool right now. */
	updating?: string;
	/** macOS has not allowed a folder; information only. */
	access?: string;
}

function linkedToApp(): boolean {
	try {
		return lstatSync(link).isSymbolicLink() && readlinkSync(link) === staged();
	} catch {
		return false;
	}
}

function linkExists(): boolean {
	try {
		lstatSync(link);
		return true;
	} catch {
		return false;
	}
}

/** The line the CLI's own installer adds, so neither adds it twice. */
function addPathLine(): void {
	if (shellHasLocalBin()) return;
	const shell = loginShell();
	const home = homedir();
	let profile: string;
	let line = `export PATH='${localBin.replaceAll("'", "'\\''")}':"$PATH"`;
	if (shell.endsWith("/zsh"))
		profile = join(process.env.ZDOTDIR || home, ".zshrc");
	else if (shell.endsWith("/bash"))
		profile = existsSync(join(home, ".bash_profile"))
			? join(home, ".bash_profile")
			: join(home, ".bashrc");
	else if (shell.endsWith("/fish")) {
		profile = join(
			process.env.XDG_CONFIG_HOME || join(home, ".config"),
			"fish",
			"config.fish",
		);
		line = `fish_add_path '${localBin.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
	} else return log(`cli: unknown shell, PATH line not added`);
	try {
		const text = existsSync(profile) ? readFileSync(profile, "utf8") : "";
		if (text.split("\n").includes(line)) return;
		mkdirSync(dirname(profile), { recursive: true });
		appendFileSync(profile, `\n# Added by the Tedix app\n${line}\n`);
		log(`cli: added ~/.local/bin to PATH in ${profile}`);
	} catch (error) {
		log(`cli: could not add the PATH line (${(error as Error).message})`);
	}
}

/** Points `~/.local/bin/tedix` at the app's copy, replacing it in one step. */
function linkToApp(): void {
	mkdirSync(localBin, { recursive: true });
	rmSync(`${link}.app-link`, { force: true });
	symlinkSync(staged(), `${link}.app-link`);
	renameSync(`${link}.app-link`, link);
}

/**
 * Puts a command-line tool in the app's data folder in one step: writes it
 * beside the copy in use, signs it with the person's own local identity when
 * they made one, checks that it starts as version `want`, keeps the copy in
 * use as `tedix.other-app`, and renames the new file over it.
 */
async function install(bytes: Buffer, want: string): Promise<void> {
	mkdirSync(stagedFolder(), { recursive: true });
	const fresh = `${staged()}.new-${process.pid}`;
	try {
		// A fresh file, so nothing macOS attached to a download comes along.
		writeFileSync(fresh, bytes, { mode: 0o755 });
		chmodSync(fresh, 0o755);
		const identities = await run("/usr/bin/security", [
			"find-identity",
			"-p",
			"codesigning",
		]);
		if (identities.output.includes('"Tedix CLI (local)"'))
			await run("/usr/bin/codesign", [
				"--force",
				"--sign",
				"Tedix CLI (local)",
				"--identifier",
				"dev.tedix.cli",
				fresh,
			]);
		const got = await versionOf(fresh);
		if (got !== want)
			throw new Error(
				`The new command-line tool did not start as version ${want}; the one in use was kept.`,
			);
		if (existsSync(staged())) {
			copyFileSync(staged(), `${other()}.new`);
			renameSync(`${other()}.new`, other());
		}
		renameSync(fresh, staged());
		writeFileSync(join(stagedFolder(), MARKER), "");
	} finally {
		rmSync(fresh, { force: true });
	}
}

/** Removes what earlier versions of the app left in the data folder. Run once. */
function tidy(): void {
	for (const name of ["update-state.json", "update-state.json.before-clear"])
		rmSync(join(stagedFolder(), name), { force: true });
	const old = `${staged()}.previous-app`;
	if (existsSync(old) && !existsSync(other())) renameSync(old, other());
	rmSync(old, { force: true });
}

let tidied = false;
let insideVersion: Promise<string> | undefined;
/** The newest published version the app has seen; it only reads the release list. */
let published = "";
let lastUpdate: CliState["update"];
let updating: string | undefined;
let updateRun: Promise<void> | undefined;
/** When the background service was last reloaded from this app. */
let reloadedAt = 0;

/** The newer of the copy inside the app and the published one, when newer than `have`. */
async function offered(have: string): Promise<string | undefined> {
	const source = bundled();
	insideVersion ??= source ? versionOf(source) : Promise.resolve("");
	const inside = await insideVersion;
	const best =
		inside && (!published || isNewer(inside, published)) ? inside : published;
	return have && best && isNewer(best, have) ? best : undefined;
}

/**
 * What the background service wrote since the last reload about a folder
 * macOS does not let it read. Information for the person, never a failure.
 */
function accessNote(): string | undefined {
	if (!reloadedAt) return;
	const from = Math.floor(reloadedAt / 1000) * 1000;
	let line: string | undefined;
	try {
		line = readFileSync(join(configDir(), "supervisor.log"), "utf8")
			.slice(-400_000)
			.split("\n")
			.findLast(
				(entry) =>
					entry.includes("could not read") &&
					Date.parse(entry.slice(0, 20)) >= from,
			);
	} catch {
		/* No log yet. */
	}
	if (!line) return;
	const path = /could not read (\/\S+)/.exec(line)?.[1] ?? "";
	const home = `${homedir()}/`;
	const folder = path.startsWith(home)
		? `your ${path.slice(home.length).split("/")[0]} folder`
		: path || "a folder";
	return `Some earlier sessions could not be reopened because macOS has not allowed access to ${folder}. Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access) and allow Tedix.`;
}

/**
 * Run at start and on every refresh: reads which command-line tool is in
 * use. It copies the one inside the app only when the app has no copy yet,
 * and links it only when nothing else is installed. It never replaces a copy
 * and never touches the background service.
 */
export async function readCli(): Promise<CliState> {
	const canRestore = existsSync(kept);
	const source = bundled();
	if (!source) {
		const version = linkExists() ? await versionOf(link) : "";
		return { kind: version ? "own" : "missing", version, canRestore: false };
	}
	try {
		if (!tidied) {
			tidy();
			tidied = true;
		}
		if (!existsSync(staged()) && !updateRun) {
			const want = await versionOf(source);
			if (!want)
				throw new Error("The command-line tool inside the app did not start.");
			await install(readFileSync(source), want);
			log(`cli: copied version ${want} from the app`);
		}
		if (!linkExists()) {
			linkToApp();
			addPathLine();
			log("cli: linked ~/.local/bin/tedix to the app's copy");
		}
		const version = await versionOf(staged());
		const state = {
			canRestore,
			offer: await offered(version),
			other: existsSync(other()) ? await versionOf(other()) : undefined,
			update: lastUpdate,
			updating,
			access: accessNote(),
		};
		return linkedToApp()
			? { kind: "included", version, ...state }
			: { kind: "separate", version: await versionOf(link), ...state };
	} catch (error) {
		const problem = error instanceof Error ? error.message : String(error);
		log(`cli: ${problem}`);
		return { kind: "missing", version: "", canRestore, problem };
	}
}

export async function supervisorLoaded(): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	return (
		await run("/bin/launchctl", [
			"print",
			`gui/${process.getuid?.()}/${SUPERVISOR}`,
		])
	).ok;
}

/**
 * Reloads the background service. A plain restart is not enough after the
 * command-line tool's file was replaced: macOS then refuses to start the
 * loaded job, so it is unloaded and loaded again from its settings file.
 * Only ever called after a click.
 */
export async function restartSupervisor() {
	const domain = `gui/${process.getuid?.()}`;
	const plist = join(
		homedir(),
		"Library",
		"LaunchAgents",
		`${SUPERVISOR}.plist`,
	);
	const pause = () => new Promise((resolve) => setTimeout(resolve, 500));
	reloadedAt = Date.now();
	await run("/bin/launchctl", ["bootout", `${domain}/${SUPERVISOR}`]);
	// Unloading finishes after the command returns: macOS gives the service
	// up to 20 seconds to stop, and loading fails until it is gone.
	for (let waited = 0; waited < 60 && (await supervisorLoaded()); waited++)
		await pause();
	let result = await run("/bin/launchctl", ["bootstrap", domain, plist]);
	for (let tries = 0; !result.ok && tries < 10; tries++) {
		if (await supervisorLoaded()) {
			result = { ...result, ok: true };
			break;
		}
		await pause();
		result = await run("/bin/launchctl", ["bootstrap", domain, plist]);
	}
	// The person's own restart worked: the runners are not down any more.
	if (result.ok && lastUpdate?.down) lastUpdate = undefined;
	return result;
}

/** How many of the switched-on runners the background service has running. */
async function runnersUp(): Promise<
	{ running: number; enabled: number } | undefined
> {
	try {
		const report = JSON.parse(
			(await run(link, ["supervise", "runners"], { timeoutMs: 30_000 })).output,
		) as { runners?: { running?: boolean; enabled?: boolean }[] };
		const enabled = (report.runners ?? []).filter(
			(runner) => runner.enabled !== false,
		);
		return {
			running: enabled.filter((runner) => runner.running === true).length,
			enabled: enabled.length,
		};
	} catch {
		return undefined;
	}
}

/**
 * Reloads the background service after the person chose a change, when it
 * is installed, and waits up to three minutes for the switched-on runners.
 * The runners are down only when the service is not running afterwards or
 * no runner came up; that is shown in red and as one notification.
 */
async function reload(
	say: (line: string) => void,
): Promise<{ down?: string; runners: string }> {
	if (!lastUpdate?.down && !(await supervisorLoaded())) return { runners: "" };
	say("Restarting the background service…");
	const restart = await restartSupervisor();
	let now: Awaited<ReturnType<typeof runnersUp>>;
	for (let waited = 0; restart.ok && waited < 180; waited += 5) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		now = await runnersUp();
		say(
			`Waiting for runners: ${now?.running ?? 0} of ${now?.enabled ?? 0} running…`,
		);
		if (now && now.running >= now.enabled) break;
	}
	const why = !restart.ok
		? `The background service did not start: ${lastLine(restart.output) || "no reason given"}.`
		: !(await supervisorLoaded())
			? "The background service is not running."
			: !now || (now.enabled > 0 && now.running === 0)
				? "No runner started within three minutes."
				: "";
	if (!why)
		return {
			runners: ` ${now?.running} of ${now?.enabled} runners are running.`,
		};
	const down = `This Mac's runners are down. ${why} Choose Restart runners in Tedix → This Mac… to try again.`;
	lastUpdate = { ok: false, down: true, text: down, at: Date.now() };
	log(`cli: ${down}`);
	if (Notification.isSupported())
		new Notification({
			title: "Tedix runners are down on this Mac",
			body: down,
		}).show();
	return { down, runners: "" };
}

/**
 * "Let the app manage it": keeps the separate install as
 * `tedix.before-app`, links the app's copy and restarts the background
 * service. A copy that does not start puts the separate install back at
 * once; after the restart, going back is the person's choice.
 */
export async function manageCli(say: (line: string) => void): Promise<string> {
	if (!existsSync(staged())) throw new Error("The app has no copy to use.");
	if (linkedToApp()) return "The app already manages it.";
	rmSync(kept, { force: true });
	renameSync(link, kept);
	try {
		linkToApp();
		if (!(await versionOf(link)))
			throw new Error("The app's copy did not start from ~/.local/bin.");
	} catch (error) {
		rmSync(link, { force: true });
		renameSync(kept, link);
		throw error;
	}
	addPathLine();
	log("cli: the app now manages ~/.local/bin/tedix; separate install kept");
	const { down, runners } = await reload(say);
	if (down) throw new Error(down);
	return `The app's copy is in use.${runners}`;
}

/** "Use the separate install again": the exact reverse of `manageCli`. */
export async function restoreCli(say: (line: string) => void): Promise<string> {
	if (!existsSync(kept)) throw new Error("No separate install was kept.");
	if (!linkedToApp())
		throw new Error("~/.local/bin/tedix is not the app's copy any more.");
	renameSync(kept, link);
	log("cli: separate install put back");
	const { down, runners } = await reload(say);
	if (down) throw new Error(down);
	return `The separate install is in use again.${runners}`;
}

async function download(path: string, timeoutMs: number): Promise<Response> {
	const response = await fetch(`${DOWNLOADS}/${path}`, {
		redirect: "error",
		cache: "no-store",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok)
		throw new Error(`${DOWNLOADS}/${path} answered ${response.status}`);
	return response;
}

/** The published tool for this Mac, refused unless it matches that release's SHA256SUMS. */
async function fetchRelease(version: string): Promise<Buffer> {
	const asset = `tedix-${version}-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
	const sums = await (
		await download(`releases/${version}/SHA256SUMS`, 30_000)
	).text();
	const expected = sums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([, name]) => name === asset || name === `*${asset}`);
	const sha256 = expected[0]?.[0] ?? "";
	if (expected.length !== 1 || !/^[0-9a-f]{64}$/.test(sha256))
		throw new Error(`Release ${version} lists no single checksum for ${asset}`);
	const bytes = Buffer.from(
		await (
			await download(`releases/${version}/${asset}`, 10 * 60_000)
		).arrayBuffer(),
	);
	if (createHash("sha256").update(bytes).digest("hex") !== sha256)
		throw new Error("The download did not match its checksum");
	return bytes;
}

let changed: () => void = () => {};
/** Sets what is called whenever there is something new to show about the tool. */
export function onCliChange(listener: () => void): void {
	changed = listener;
}

/** Runs one change the person chose at a time and shows how it ended. */
function track(
	work: (say: (line: string) => void) => Promise<string>,
): Promise<void> {
	updateRun ??= work((line) => {
		updating = line;
		log(`cli: ${line}`);
		changed();
	})
		.then((text) => {
			// A reload that left the runners down has already said so.
			if (!lastUpdate?.down) lastUpdate = { ok: true, text, at: Date.now() };
		})
		.catch((error) => {
			const reason = error instanceof Error ? error.message : String(error);
			lastUpdate = {
				ok: false,
				text: `The command-line tool was not changed: ${reason}`,
				at: Date.now(),
			};
		})
		.finally(() => {
			if (lastUpdate) log(`cli: ${lastUpdate.text}`);
			updating = undefined;
			updateRun = undefined;
			changed();
		});
	return updateRun;
}

/**
 * Reads which command-line tool is published and remembers it, so the
 * windows can offer it. Changes nothing on this Mac. `asked` is true when
 * the person chose it: then the answer is shown either way.
 */
export async function lookForCliUpdate(asked: boolean): Promise<void> {
	if (process.platform !== "darwin" || !existsSync(staged())) return;
	let text: string;
	try {
		const latest = (await (await download("latest.json", 30_000)).json()) as {
			version?: unknown;
		};
		if (
			typeof latest.version !== "string" ||
			!/^\d+\.\d+\.\d+$/.test(latest.version)
		)
			throw new Error("The release list is not valid");
		published = latest.version;
		const have = await versionOf(staged());
		const offer = await offered(have);
		text = offer
			? `Version ${offer} is available.`
			: `Version ${have} is the newest command-line tool.`;
	} catch (error) {
		text = `Could not look for a newer command-line tool: ${(error as Error).message}`;
	}
	log(`cli: ${text}`);
	if (asked && !updateRun && !lastUpdate?.down)
		lastUpdate = { ok: true, text, at: Date.now() };
	changed();
}

/**
 * "Update command-line tool to X", after the person's click: puts the newer
 * of the copy inside the app and the published one in place, keeps the one
 * in use as `tedix.other-app`, and restarts the background service.
 */
export function updateCli(): Promise<void> {
	return track(async (say) => {
		const have = await versionOf(staged());
		const version = await offered(have);
		if (!version) return `Version ${have} is the newest command-line tool.`;
		const source = bundled();
		let bytes: Buffer;
		if (source && (await insideVersion) === version)
			bytes = readFileSync(source);
		else {
			say(`Downloading command-line tool ${version}…`);
			bytes = await fetchRelease(version);
		}
		say(`Putting version ${version} in place…`);
		await install(bytes, version);
		const { runners } = linkedToApp() ? await reload(say) : { runners: "" };
		return `Updated to ${version}; version ${have} is kept.${runners}`;
	});
}

/**
 * "Go back to version Y", after the person's click: swaps the copy in use
 * with the kept one and restarts the background service.
 */
export function goBackCli(): Promise<void> {
	return track(async (say) => {
		if (!existsSync(other()) || !existsSync(staged()))
			throw new Error("No other version is kept.");
		const [have, back] = [await versionOf(staged()), await versionOf(other())];
		if (!back) throw new Error("The kept version does not start.");
		say(`Putting version ${back} back in place…`);
		// A second name for the copy in use, so `cli/tedix` is never missing.
		const aside = `${staged()}.swap-${process.pid}`;
		rmSync(aside, { force: true });
		linkSync(staged(), aside);
		renameSync(other(), staged());
		renameSync(aside, other());
		const { runners } = linkedToApp() ? await reload(say) : { runners: "" };
		return `Back on version ${back}; version ${have} is kept.${runners}`;
	});
}
