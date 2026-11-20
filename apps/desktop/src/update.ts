import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	createWriteStream,
	existsSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";
import { log } from "./log";

/**
 * The app's own updater. The app is not signed or notarized yet, so the
 * updater built into Electron does not work. Everything comes from this one
 * https address, laid out like the CLI's releases; see the README for the
 * files a release must publish.
 */
const RELEASES = "https://downloads.tedix.dev/desktop";

export type UpdateResult =
	| { kind: "ready"; version: string }
	| { kind: "current" }
	| { kind: "unavailable"; reason: string };

/** A downloaded, checked and unpacked newer app, waiting for a restart. */
let ready: { version: string; bundle: string } | undefined;
let checking: Promise<UpdateResult> | undefined;

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

function isNewer(candidate: string, current: string): boolean {
	const a = candidate.split(".").map(Number);
	const b = current.split(".").map(Number);
	for (let part = 0; part < 3; part++)
		if (a[part] !== b[part]) return (a[part] ?? 0) > (b[part] ?? 0);
	return false;
}

async function get(url: string, timeoutMs: number): Promise<Response> {
	const response = await fetch(url, {
		redirect: "error",
		cache: "no-store",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok || !response.body)
		throw new Error(`${url} answered ${response.status}`);
	return response;
}

async function check(): Promise<UpdateResult> {
	if (ready) return { kind: "ready", version: ready.version };
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
		assets?: { name?: unknown; sha256?: unknown }[];
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

	const folder = mkdtempSync(join(app.getPath("temp"), "tedix-update-"));
	try {
		const zip = join(folder, name);
		const hash = createHash("sha256");
		const download = await get(
			`${RELEASES}/releases/${version}/${name}`,
			30 * 60_000,
		);
		await pipeline(
			Readable.fromWeb(download.body as never),
			async function* (chunks: AsyncIterable<Buffer>) {
				for await (const chunk of chunks) {
					hash.update(chunk);
					yield chunk;
				}
			},
			createWriteStream(zip),
		);
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
		log(`update: ${version} is ready`);
		return { kind: "ready", version };
	} catch (error) {
		rmSync(folder, { recursive: true, force: true });
		throw error;
	}
}

/** Looks for a newer release and gets it ready. One check runs at a time. */
export function checkForUpdate(): Promise<UpdateResult> {
	checking ??= check().finally(() => {
		checking = undefined;
	});
	return checking;
}

/** The version waiting for a restart, if any. */
export function readyVersion(): string | undefined {
	return ready?.version;
}

// $1 the running app's process, $2 the installed Tedix.app, $3 the new one.
// Waits for the app to exit, copies the new app next to the installed one,
// swaps them, and puts the old one back if the swap fails.
const REPLACE = `
while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
rm -rf "$2.update" "$2.previous"
/usr/bin/ditto "$3" "$2.update" && mv "$2" "$2.previous" && mv "$2.update" "$2"
[ -d "$2" ] || mv "$2.previous" "$2"
rm -rf "$2.update" "$2.previous" "$(dirname "$3")"
open "$2"
`;

/** Quits, replaces the installed app with the ready one, and opens it again. */
export function restartToUpdate(): void {
	if (!ready) return;
	log(`update: restarting into ${ready.version}`);
	spawn(
		"/bin/sh",
		["-c", REPLACE, "sh", String(process.pid), installedBundle(), ready.bundle],
		{ detached: true, stdio: "ignore" },
	).unref();
	app.quit();
}
