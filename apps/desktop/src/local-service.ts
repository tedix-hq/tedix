import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, createWriteStream } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

const payload = () => join(process.resourcesPath, "local-workspace.tar.gz");
let processOwner: ChildProcess | undefined;
let ready = false;
let startup: Promise<void> | undefined;
const shutdown = new AbortController();
const localData = () => join(app.getPath("userData"), "Local Workspace");
const started = () => join(localData(), "started");

export function bundledLocalWasStarted(): boolean {
	return existsSync(started());
}

function stop(child: ChildProcess) {
	if (child.pid && child.exitCode === null) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
	}
}

export function bundledLocalAvailable(): boolean {
	return app.isPackaged && existsSync(payload());
}

export function bundledLocalRunning(): boolean {
	return ready;
}

async function unpack(directory: string) {
	if (existsSync(join(directory, "bin", "bun"))) return;
	const temporary = await mkdtemp(join(directory, "..", "install-"));
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn("/usr/bin/tar", ["-xf", payload(), "-C", temporary], {
				signal: shutdown.signal,
			});
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0
					? resolve()
					: reject(new Error("Local workspace extraction failed")),
			);
		});
		await rename(temporary, directory);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

async function start() {
	const state = localData();
	await mkdir(state, { recursive: true, mode: 0o700 });
	const runtime = join(state, `runtime-${app.getVersion()}`);
	await unpack(runtime);
	shutdown.signal.throwIfAborted();
	const sourceSha = (
		await readFile(join(runtime, "source-sha"), "utf8")
	).trim();
	if (!/^[a-f0-9]{40}$/.test(sourceSha))
		throw new Error("Local workspace is missing its build version.");
	const log = createWriteStream(join(state, "startup.log"), {
		flags: "w",
		mode: 0o600,
	});
	log.on("error", () => {});
	const child = spawn(
		join(runtime, "bin", "bun"),
		["scripts/run-local.ts", "--demo", "--no-install", "--verbose"],
		{
			cwd: runtime,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				PATH: `${join(runtime, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
				TEDIX_LOCAL_PERSIST_TO: join(state, "workspace"),
				TEDIX_BUILD_SHA: sourceSha,
				CI: "1",
				WRANGLER_SEND_METRICS: "false",
				ASTRO_TELEMETRY_DISABLED: "1",
			},
		},
	);
	processOwner = child;
	child.stdout.pipe(log, { end: false });
	child.stderr.pipe(log, { end: false });
	child.once("close", () => {
		log.end();
		processOwner = undefined;
		ready = false;
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop(child);
			finish(new Error("Local workspace did not finish starting"));
		}, 300_000);
		let tail = "";
		function finish(error?: Error) {
			clearTimeout(timeout);
			child.stdout.off("data", read);
			if (error) reject(error);
			else resolve();
		}
		function read(chunk: Buffer) {
			tail = (tail + chunk.toString()).slice(-4096);
			if (!tail.includes("Tedix OS: http://localhost:3030")) return;
			ready = true;
			finish();
		}
		child.stdout.on("data", read);
		child.once("error", finish);
		child.once("close", () => finish(new Error("Local workspace stopped")));
	});
	await writeFile(started(), "", { mode: 0o600 });
}

export function startBundledLocal(): Promise<void> {
	if (ready) return Promise.resolve();
	if (processOwner && !startup)
		return Promise.reject(new Error("Local workspace is stopping"));
	return (startup ??= start().finally(() => {
		startup = undefined;
	}));
}

app.on("will-quit", () => {
	shutdown.abort();
	if (processOwner) stop(processOwner);
});
