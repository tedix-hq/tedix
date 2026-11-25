import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, net } from "electron";
import { log } from "./log";
import { isNewer } from "./version";

/**
 * The app's own updater. The app is not signed or notarized yet, so the
 * updater built into Electron does not work. Everything comes from this one
 * https address, laid out like the CLI's releases; see the README for the
 * files a release must publish.
 */
const RELEASES = "https://downloads.tedix.dev/desktop";

/** A newer published app for this Mac, found but not downloaded yet. */
export interface FoundUpdate {
	version: string;
	name: string;
	sha256: string;
	/** From the manifest; the download's own length wins when it has one. */
	size: number;
}

export type UpdateResult =
	| { kind: "found"; update: FoundUpdate }
	| { kind: "current" }
	| { kind: "unavailable"; reason: string };

/** How far the download is, for the downloading window. */
export interface DownloadProgress {
	version: string;
	received: number;
	total: number;
}

/** A downloaded, checked and unpacked newer app, waiting for a restart. */
let ready: { version: string; bundle: string } | undefined;
let downloading:
	| {
			progress: DownloadProgress;
			stop: AbortController;
			done: Promise<void>;
	  }
	| undefined;

/** The folder `Tedix.app` that this program runs from. */
function installedBundle(): string {
	return resolve(app.getPath("exe"), "../../..");
}

/** Why this copy cannot replace itself, or nothing when it can. */
function cannotUpdate(): string | undefined {
	if (process.platform !== "darwin")
		return "Updates are only available on macOS for now.";
	if (!app.isPackaged)
		return "This copy runs from source. Update it with git instead.";
	const bundle = installedBundle();
	try {
		if (!bundle.endsWith(".app")) throw new Error("Not an app folder");
		accessSync(bundle, constants.W_OK);
		accessSync(dirname(bundle), constants.W_OK);
	} catch {
		return `Tedix cannot replace itself in ${dirname(bundle)}. Move Tedix to your Applications folder and open it from there.`;
	}
	return undefined;
}

async function get(
	url: string,
	timeoutMs: number,
	stop?: AbortSignal,
): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs);
	// The app's pages load through this same network code, so a check works
	// whenever they do: after sleep, on a VPN or behind a proxy.
	const response = await net.fetch(url, {
		redirect: "error",
		cache: "no-store",
		signal: stop ? AbortSignal.any([timeout, stop]) : timeout,
	});
	if (!response.ok || !response.body)
		throw new Error(`${url} answered ${response.status}`);
	return response;
}

/** Reads which app is published. Downloads nothing. */
export async function findUpdate(): Promise<UpdateResult> {
	const reason = cannotUpdate();
	if (reason) return { kind: "unavailable", reason };

	const latest = (await (
		await get(`${RELEASES}/latest.json`, 30_000)
	).json()) as {
		version?: unknown;
	};
	const version = latest.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
		throw new Error("The release list is not valid");
	if (!isNewer(version, app.getVersion())) return { kind: "current" };

	const name = `Tedix-${version}-darwin-${process.arch}.zip`;
	const manifest = (await (
		await get(`${RELEASES}/releases/${version}/manifest.json`, 30_000)
	).json()) as {
		version?: unknown;
		assets?: { name?: unknown; sha256?: unknown; size?: unknown }[];
	};
	const asset = Array.isArray(manifest.assets)
		? manifest.assets.find((candidate) => candidate.name === name)
		: undefined;
	const sha256 = asset?.sha256;
	if (
		manifest.version !== version ||
		typeof sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(sha256)
	)
		throw new Error(`Release ${version} has no valid ${name}`);
	const size = typeof asset?.size === "number" ? asset.size : 0;
	return { kind: "found", update: { version, name, sha256, size } };
}

async function fetchApp(
	update: FoundUpdate,
	progress: DownloadProgress,
	stop: AbortSignal,
	changed: () => void,
): Promise<void> {
	const { version, name, sha256 } = update;
	const folder = mkdtempSync(join(app.getPath("temp"), "tedix-update-"));
	try {
		const zip = join(folder, name);
		const hash = createHash("sha256");
		const download = await get(
			`${RELEASES}/releases/${version}/${name}`,
			30 * 60_000,
			stop,
		);
		const length = Number(download.headers.get("content-length"));
		if (length > 0) progress.total = length;
		let shown = 0;
		await pipeline(
			Readable.fromWeb(download.body as never),
			async function* (chunks: AsyncIterable<Buffer>) {
				for await (const chunk of chunks) {
					hash.update(chunk);
					progress.received += chunk.length;
					// About ten times a second is enough for a progress bar.
					if (Date.now() - shown > 100) {
						shown = Date.now();
						changed();
					}
					yield chunk;
				}
			},
			createWriteStream(zip),
			{ signal: stop },
		);
		changed();
		if (hash.digest("hex") !== sha256)
			throw new Error("The download did not match its checksum");
		await new Promise<void>((done, failed) =>
			execFile("/usr/bin/ditto", ["-x", "-k", zip, folder], (error) =>
				error ? failed(error) : done(),
			),
		);
		rmSync(zip);
		const bundle = join(folder, "Tedix.app");
		if (!existsSync(join(bundle, "Contents", "Info.plist")))
			throw new Error("The download holds no Tedix.app");
		ready = { version, bundle };
		log(`update: ${version} is downloaded, checked and ready`);
	} catch (error) {
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Downloads, checks and unpacks a found app. One download runs at a time;
 * asking again while it runs joins it. `changed` is called as it moves.
 */
export function downloadUpdate(
	update: FoundUpdate,
	changed: () => void,
): Promise<void> {
	if (ready?.version === update.version) return Promise.resolve();
	if (downloading) return downloading.done;
	const progress = {
		version: update.version,
		received: 0,
		total: update.size,
	};
	const stop = new AbortController();
	log(`update: downloading ${update.version}`);
	const done = fetchApp(update, progress, stop.signal, changed).finally(() => {
		downloading = undefined;
		changed();
	});
	downloading = { progress, stop, done };
	changed();
	return done;
}

/** How far the running download is, as a whole percent; nothing when none runs. */
export function downloadPercent(): number | undefined {
	if (!downloading) return undefined;
	const { received, total } = downloading.progress;
	return total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : 0;
}

/** The version waiting for a restart, if any. */
export function readyVersion(): string | undefined {
	return ready?.version;
}

// $1 the running app's process, $2 the installed Tedix.app, $3 the new one.
// Waits for the app to exit, copies the new app next to the installed one,
// swaps them, and puts the old one back if the swap fails. The copies have
// hidden names, so Spotlight and launchers never list them as apps.
/**
 * Run once the app has quit: swaps the copy waiting next to the installed
 * app into place and opens it. Two renames, so the gap without a window is
 * short; it puts the old app back if the swap fails.
 */
const SWAP = `
while kill -0 "$1" 2>/dev/null; do sleep 0.1; done
old="$(dirname "$2")/.$(basename "$2").previous"
rm -rf "$old"
mv "$2" "$old" && mv "$3" "$2"
[ -d "$2" ] || mv "$old" "$2"
rm -rf "$old" "$3"
open "$2"
`;

/**
 * Puts the ready app next to the installed one, then quits so a small
 * script can swap them and open the new one. The copy happens while this
 * app still shows its window; a copy that fails leaves the app running.
 */
export async function restartToUpdate(): Promise<void> {
	if (!ready) return;
	const installed = installedBundle();
	const next = join(dirname(installed), `.${basename(installed)}.update`);
	if (ready.bundle !== next) {
		rmSync(next, { recursive: true, force: true });
		const started = Date.now();
		try {
			renameSync(ready.bundle, next);
		} catch {
			await new Promise<void>((done, failed) =>
				execFile("/usr/bin/ditto", [ready!.bundle, next], (error) =>
					error ? failed(error) : done(),
				),
			);
		}
		rmSync(dirname(ready.bundle), { recursive: true, force: true });
		ready = { ...ready, bundle: next };
		log(`update: ${ready.version} placed in ${Date.now() - started} ms`);
	}
	log(`update: restarting into ${ready.version}`);
	spawn("/bin/sh", ["-c", SWAP, "sh", String(process.pid), installed, next], {
		detached: true,
		stdio: "ignore",
	}).unref();
	app.quit();
}
