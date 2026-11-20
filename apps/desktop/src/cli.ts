import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
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
import { app } from "electron";
import { log } from "./log";
import { lastLine, localBin, loginShell, run, shellHasLocalBin } from "./shell";
import { activeRunCount } from "./status";
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
/** How long a newer tool waits for running tasks to end before it is put in place anyway. */
const QUIET_WAIT_MS = 30 * 60_000;

const stagedFolder = () => join(app.getPath("userData"), "cli");
const staged = () => join(stagedFolder(), "tedix");
/** The copy in use before the last change, for one step back by hand. */
const previous = () => `${staged()}.previous-app`;

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
	/** What happened to the background service after the app brought a new version. */
	service?: string;
	/** How the last look for a newer command-line tool ended, and when. */
	update?: { ok: boolean; text: string; at: number };
	/** What the app is doing about a newer command-line tool right now. */
	updating?: string;
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
 * use as `tedix.previous-app`, and renames the new file over it.
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
			copyFileSync(staged(), `${previous()}.new`);
			renameSync(`${previous()}.new`, previous());
		}
		renameSync(fresh, staged());
		writeFileSync(join(stagedFolder(), MARKER), "");
	} finally {
		rmSync(fresh, { force: true });
	}
}

/**
 * Copies the tool from inside the app to the app's data folder when the app
 * brought a newer version than the one there, and returns the version now
 * there. A copy that updated itself since the app was built is never
 * replaced by the older one inside the app.
 */
async function stage(
	source: string,
): Promise<{ version: string; replaced: boolean }> {
	const have = existsSync(staged()) ? await versionOf(staged()) : "";
	const want = await versionOf(source);
	if (have && (!want || !isNewer(want, have)))
		return { version: have, replaced: false };
	if (!want)
		throw new Error("The command-line tool inside the app did not start.");
	await install(readFileSync(source), want);
	log(`cli: copied version ${want} from the app${have ? ` over ${have}` : ""}`);
	return { version: want, replaced: true };
}

let service: string | undefined;

/**
 * Run at start: brings the app's copy up to date and links it when nothing
 * else is installed. A separate install is left alone and reported.
 */
export async function readCli(): Promise<CliState> {
	const canRestore = existsSync(kept);
	const source = bundled();
	if (!source) {
		const version = linkExists() ? await versionOf(link) : "";
		return { kind: version ? "own" : "missing", version, canRestore: false };
	}
	try {
		const wasLinked = linkedToApp();
		const { version, replaced } = await stage(source);
		// An app update changed the tool under a running background service:
		// restart it so it does not keep running the version before.
		if (replaced && wasLinked && (await supervisorLoaded())) {
			const restart = await restartSupervisor();
			service = restart.ok
				? `The background service was restarted to use version ${version}.`
				: `The background service still runs the version before ${version} and could not be restarted: ${lastLine(restart.output)}. Choose Restart runners in Tedix → This Mac….`;
			log(`cli: ${service}`);
		}
		if (!linkExists()) {
			linkToApp();
			addPathLine();
			log("cli: linked ~/.local/bin/tedix to the app's copy");
		}
		if (linkedToApp())
			return {
				kind: "included",
				version,
				canRestore,
				service,
				update: lastUpdate,
				updating,
			};
		return {
			kind: "separate",
			version: await versionOf(link),
			canRestore,
			update: lastUpdate,
			updating,
		};
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
	await run("/bin/launchctl", ["bootout", `${domain}/${SUPERVISOR}`]);
	// Unloading finishes after the command returns: macOS gives the service
	// up to 20 seconds to stop, and loading fails until it is gone.
	for (let waited = 0; waited < 60 && (await supervisorLoaded()); waited++)
		await pause();
	let result = await run("/bin/launchctl", ["bootstrap", domain, plist]);
	for (let tries = 0; !result.ok && tries < 10; tries++) {
		if (await supervisorLoaded()) return { ok: true, output: result.output };
		await pause();
		result = await run("/bin/launchctl", ["bootstrap", domain, plist]);
	}
	return result;
}

/** How many of the switched-on runners the background service has running. */
async function runnersUp(): Promise<{ running: number; enabled: number }> {
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
		return { running: 0, enabled: 0 };
	}
}

/**
 * Restarts the background service when it is installed and waits until as
 * many runners are running as before. Returns one sentence on how it went.
 */
async function restartAndConfirm(
	before: number,
	say: (line: string) => void,
): Promise<string> {
	if (!(await supervisorLoaded())) return "";
	say("Restarting the background service…");
	const restart = await restartSupervisor();
	if (!restart.ok)
		throw new Error(
			`The background service did not restart: ${lastLine(restart.output)}`,
		);
	let now = { running: 0, enabled: 0 };
	for (let waited = 0; waited < 180; waited += 5) {
		await new Promise((resolve) => setTimeout(resolve, 5000));
		now = await runnersUp();
		say(`Waiting for runners: ${now.running} of ${now.enabled} running…`);
		if (now.running >= before && now.running >= now.enabled) break;
	}
	if (now.running < before)
		throw new Error(
			`Only ${now.running} of ${before} runners came back after three minutes. Check ~/.tedix/supervisor.log; macOS may be asking to allow access to your folders again.`,
		);
	return ` ${now.running} of ${now.enabled} runners are running again.`;
}

/**
 * "Let the app manage it": keeps the separate install as
 * `tedix.before-app`, links the app's copy and restarts the background
 * service. Any failure before the restart puts the separate install back.
 */
export async function manageCli(say: (line: string) => void): Promise<string> {
	if (!existsSync(staged())) throw new Error("The app has no copy to use.");
	if (linkedToApp()) return "The app already manages it.";
	const before = (await runnersUp()).running;
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
	return `The app's copy is in use.${await restartAndConfirm(before, say)}`;
}

/** "Use the separate install again": the exact reverse of `manageCli`. */
export async function restoreCli(say: (line: string) => void): Promise<string> {
	if (!existsSync(kept)) throw new Error("No separate install was kept.");
	if (!linkedToApp())
		throw new Error("~/.local/bin/tedix is not the app's copy any more.");
	const before = (await runnersUp()).running;
	renameSync(kept, link);
	log("cli: separate install put back");
	return `The separate install is in use again.${await restartAndConfirm(before, say)}`;
}

let lastUpdate: CliState["update"];
let updating: string | undefined;
let updateRun: Promise<void> | undefined;

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

const runs = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

async function update(asked: boolean, changed: () => void): Promise<void> {
	if (process.platform !== "darwin" || !existsSync(staged())) {
		if (asked)
			lastUpdate = {
				ok: true,
				text: "This app has no command-line tool of its own to update.",
				at: Date.now(),
			};
		return;
	}
	const say = (line: string) => {
		updating = line;
		log(`cli update: ${line}`);
		changed();
	};
	const have = await versionOf(staged());
	const latest = (await (await download("latest.json", 30_000)).json()) as {
		version?: unknown;
	};
	const version = latest.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
		throw new Error("The release list is not valid");
	if (have && !isNewer(version, have)) {
		log(`cli update: ${have} in use, ${version} published, nothing to do`);
		if (asked || lastUpdate?.ok === false)
			lastUpdate = {
				ok: true,
				text: `Version ${have} is the newest command-line tool.`,
				at: Date.now(),
			};
		return;
	}
	say(`Downloading command-line tool ${version}…`);
	const bytes = await fetchRelease(version);
	log(`cli update: ${version} downloaded and matches its checksum`);

	// Reloading the background service stops tasks that are running, so wait
	// for a moment without any, but not for ever.
	const inUse = linkedToApp() && (await supervisorLoaded());
	let stopped = 0;
	if (inUse) {
		const giveUp = Date.now() + QUIET_WAIT_MS;
		while ((stopped = await activeRunCount()) > 0 && Date.now() < giveUp) {
			say(
				`Version ${version} is ready. Waiting for ${runs(stopped)} to finish, for up to 30 minutes.`,
			);
			await new Promise((resolve) => setTimeout(resolve, 30_000));
		}
	}
	const before = inUse ? (await runnersUp()).running : 0;
	say(`Putting version ${version} in place…`);
	await install(bytes, version);
	log(
		`cli update: ${version} is in place${have ? `, ${have} kept as tedix.previous-app` : ""}`,
	);
	const waited =
		stopped > 0
			? ` ${runs(stopped)} still ran after 30 minutes and ${stopped === 1 ? "was" : "were"} stopped.`
			: "";
	if (!inUse) {
		lastUpdate = { ok: true, text: `Updated to ${version}.`, at: Date.now() };
		return;
	}
	try {
		const restarted = await restartAndConfirm(before, say);
		lastUpdate = {
			ok: true,
			text: `Updated to ${version}; runners restarted.${restarted}${waited}`,
			at: Date.now(),
		};
	} catch (error) {
		lastUpdate = {
			ok: false,
			text: `Updated to ${version}. ${(error as Error).message} Choose Restart runners in Tedix → This Mac… to try again.${waited}`,
			at: Date.now(),
		};
	}
}

/**
 * Looks for a newer published command-line tool and puts it in place of the
 * app's copy, without an app release. One look runs at a time. `asked` is
 * true when the person chose it, so "nothing newer" is said too; `changed`
 * is called whenever there is something new to show.
 */
export function updateCli(asked: boolean, changed: () => void): Promise<void> {
	updateRun ??= update(asked, changed)
		.catch((error) => {
			const reason = error instanceof Error ? error.message : String(error);
			lastUpdate = {
				ok: false,
				text: `The command-line tool was not updated: ${reason}`,
				at: Date.now(),
			};
		})
		.finally(() => {
			if (lastUpdate) log(`cli update: ${lastUpdate.text}`);
			updating = undefined;
			updateRun = undefined;
			changed();
		});
	return updateRun;
}
