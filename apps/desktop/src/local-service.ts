import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { app } from "electron";

const run = promisify(execFile);
const payload = () => join(process.resourcesPath, "local-workspace.tar.gz");
let processOwner: ChildProcess | undefined;
let ready = false;
let startup: Promise<void> | undefined;
let preparingRuntime: Promise<string> | undefined;
const shutdown = new AbortController();
const localData = () => join(app.getPath("userData"), "Local Workspace");

export type DemoProgress = (message: string) => void;
export type DemoCloudflare = { accountId: string; gateway: string };
export type CloudflareAccount = { id: string; name: string };
let cloudflare: DemoCloudflare | undefined;

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

function prepareRuntime(): Promise<string> {
	return (preparingRuntime ??= (async () => {
		const state = localData();
		await mkdir(state, { recursive: true, mode: 0o700 });
		const runtime = join(state, `runtime-${app.getVersion()}`);
		await unpack(runtime);
		shutdown.signal.throwIfAborted();
		return runtime;
	})().finally(() => {
		preparingRuntime = undefined;
	}));
}

async function wrangler(args: string[], timeout: number) {
	const runtime = await prepareRuntime();
	return run(
		join(runtime, "bin", "node"),
		[join(runtime, "node_modules", "wrangler", "bin", "wrangler.js"), ...args],
		{
			cwd: runtime,
			env: {
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				WRANGLER_SEND_METRICS: "false",
			},
			timeout,
			signal: shutdown.signal,
		},
	);
}

export async function cloudflareAccounts(): Promise<CloudflareAccount[]> {
	const { stdout } = await wrangler(["whoami", "--json"], 25_000);
	const { accounts } = JSON.parse(stdout) as { accounts?: CloudflareAccount[] };
	return (accounts ?? []).filter(
		(account) =>
			typeof account.id === "string" &&
			/^[a-f0-9]{32}$/i.test(account.id) &&
			typeof account.name === "string",
	);
}

export async function signInToCloudflare(): Promise<void> {
	await wrangler(
		[
			"login",
			"--scopes",
			"account:read",
			"user:read",
			"workers_scripts:write",
			"ai:write",
		],
		300_000,
	);
}

export const demoCloudflare = () => cloudflare;

async function start(
	progress: DemoProgress,
	inference?: DemoCloudflare | null,
) {
	const state = localData();
	progress("Getting the demo ready on this Mac");
	const runtime = await prepareRuntime();
	progress("Checking the files Tedix needs");
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
	// macOS can take longer than the launcher's normal five-second PATH check
	// to verify the bundled binary on first use.
	try {
		await run(join(runtime, "bin", "node"), ["--version"], {
			timeout: 30_000,
			signal: shutdown.signal,
		});
	} catch (error) {
		log.end(String(error));
		throw error;
	}
	const child = spawn(
		join(runtime, "bin", "bun"),
		[
			"scripts/run-local.ts",
			"--demo",
			"--no-install",
			"--verbose",
			...(inference
				? [
						"--inference",
						`--workers-ai-account=${inference.accountId}`,
						inference.gateway
							? `--ai-gateway=${inference.gateway}`
							: "--ai-routing=direct",
					]
				: []),
		],
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
		cloudflare = undefined;
	});
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop(child);
			finish(new Error("Local workspace did not finish starting"));
		}, 300_000);
		let tail = "";
		let phase = -1;
		const milestones = [
			[
				"Applying isolated local database migrations",
				"Preparing your workspace",
			],
			[
				"Seeding the optional deterministic demo workspace",
				"Adding a sample project and files",
			],
			[
				"Building the Tedix OS Worker and assets",
				"Getting your workspace ready to open",
			],
			[
				"Starting the API, MCP gateway and Tedix OS",
				"Starting Tedix on this Mac",
			],
			[
				"Provisioning seeded workspace file storage",
				"Putting the sample files in place",
			],
		] as const;
		function finish(error?: Error) {
			clearTimeout(timeout);
			child.stdout.off("data", read);
			if (error) reject(error);
			else resolve();
		}
		function read(chunk: Buffer) {
			tail = (tail + chunk.toString()).slice(-4096);
			for (const [index, [marker, message]] of milestones.entries())
				if (index > phase && tail.includes(marker)) {
					phase = index;
					progress(message);
				}
			if (!tail.includes("Tedix OS: http://localhost:3030")) return;
			ready = true;
			cloudflare = inference ?? undefined;
			finish();
		}
		child.stdout.on("data", read);
		child.once("error", finish);
		child.once("close", () => finish(new Error("Local workspace stopped")));
	});
}

export function startBundledLocal(
	progress: DemoProgress,
	inference?: DemoCloudflare | null,
): Promise<void> {
	if (ready && (inference === undefined || (!inference && !cloudflare)))
		return Promise.resolve();
	return (startup ??= (async () => {
		if (processOwner) {
			const exited = once(processOwner, "close");
			stop(processOwner);
			await exited;
		}
		await start(progress, inference);
	})().finally(() => {
		startup = undefined;
	}));
}

app.on("will-quit", () => {
	shutdown.abort();
	if (processOwner) stop(processOwner);
});
