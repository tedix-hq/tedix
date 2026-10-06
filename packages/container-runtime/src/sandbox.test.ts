import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { NativeContainerSandbox } from "./sandbox";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {},
	RpcTarget: class {},
}));
vi.mock("@cloudflare/sandbox", () => ({
	SandboxFileError: { is: () => false },
	Files: class {
		constructor(private container: { root: string }) {}
		async mkdir(path: string, options: { recursive?: boolean } = {}) {
			mkdirSync(this.path(path), options);
		}
		async writeFile(path: string, content: string) {
			writeFileSync(this.path(path), content);
		}
		async remove(path: string) {
			rmSync(this.path(path), { recursive: true, force: true });
		}
		async readFile(path: string) {
			return new Response(readFileSync(this.path(path)));
		}
		private path(path: string) {
			return path.replace("/var/lib/tedix-processes", this.container.root);
		}
	},
}));

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "tedix-process-"));
	directories.push(directory);
	const root = join(directory, "processes");
	const boot = join(directory, "boot");
	const signals = join(directory, "signals");
	writeFileSync(boot, "boot-one\n");
	let onKill: (() => void) | undefined;
	const commands: string[][] = [];
	const container = {
		root,
		running: true,
		setInactivityTimeout: async () => {},
		exec: async (argv: string[]) => {
			commands.push(argv);
			if (argv[3] === "kill") onKill?.();
			const command = argv.map((value) =>
				value
					.replaceAll("/var/lib/tedix-processes", root)
					.replaceAll("/proc/sys/kernel/random/boot_id", boot),
			);
			if (command[0] === "/bin/sh" && command[1] === "-c") {
				// Run the production scripts. Stub only Linux setsid/liveness/signal
				// syscalls so boot changes and signal targets are deterministic on macOS.
				command[2] = `setsid() { "$@"; }; kill() { [ "$1" = "-0" ] && return 0; printf '%s\\n' "$*" >> '${signals}'; };\n${command[2]}`;
			}
			const result = spawnSync(command[0]!, command.slice(1), {
				encoding: "utf8",
				timeout: 2000,
			});
			return {
				output: async () => ({
					exitCode: result.status ?? 1,
					stdout: new TextEncoder().encode(result.stdout ?? "").buffer,
					stderr: new TextEncoder().encode(result.stderr ?? "").buffer,
				}),
			};
		},
	};
	class Sandbox extends NativeContainerSandbox<{}> {
		protected startOptions() {
			return { image: "test" };
		}
		protected get containerTelemetrySurface() {
			return "test";
		}
	}
	const sandbox = new Sandbox(
		{
			container,
			blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
		} as never,
		{},
	);
	const seed = (exitCode?: number) => {
		const process = join(root, "one");
		mkdirSync(process, { recursive: true });
		writeFileSync(
			join(process, "process.json"),
			JSON.stringify({
				id: "one",
				command: ["build"],
				cwd: "/workspace",
				startedAt: "2026-10-03T00:00:00Z",
				timeoutMs: null,
			}),
		);
		writeFileSync(join(process, "pid"), "123 boot-one\n");
		if (exitCode !== undefined)
			writeFileSync(join(process, "exit-code"), String(exitCode));
	};
	return {
		sandbox,
		seed,
		commands,
		root,
		changeBoot: () => writeFileSync(boot, "boot-two\n"),
		onKill: (fn: () => void) => {
			onKill = fn;
		},
		signals: () => {
			try {
				return readFileSync(signals, "utf8");
			} catch {
				return "";
			}
		},
	};
}

describe("native background process boot identity", () => {
	it("records PID and boot identity during launch and preserves the actual exit", async () => {
		const f = fixture();
		const process = await f.sandbox.startProcess("one", [
			"/bin/sh",
			"-c",
			"exit 7",
		]);
		expect(readFileSync(join(f.root, "one", "pid"), "utf8")).toMatch(
			/^\d+ boot-one\n$/,
		);
		expect(await process.status()).toMatchObject({
			state: "exited",
			exit: { code: 7, timedOut: false },
		});
	});
	it("never treats the same PID on a new boot as running, waitable, or signalable", async () => {
		const f = fixture();
		f.seed();
		f.changeBoot();
		const process = (await f.sandbox.getProcess("one"))!;
		expect(await process.status()).toMatchObject({
			state: "error",
			error: { code: "PROCESS_LOST" },
		});
		await expect(process.waitForExit({ timeout: 100 })).rejects.toThrow(
			"outcome is unavailable",
		);
		await process.kill();
		expect(f.signals()).toBe("");
	});
	it("rechecks boot identity in the signal invocation after a running snapshot", async () => {
		const f = fixture();
		f.seed();
		const process = (await f.sandbox.getProcess("one"))!;
		expect((await process.status()).state).toBe("running");
		f.onKill(f.changeBoot);
		await process.kill();
		expect(f.signals()).toBe("");
	});
	it("gives atomic exit records precedence over a restored stale PID", async () => {
		const f = fixture();
		f.seed(17);
		f.changeBoot();
		const process = (await f.sandbox.getProcess("one"))!;
		expect(await process.status()).toMatchObject({
			state: "exited",
			exit: { code: 17 },
		});
		await process.waitForExit({ timeout: 100 });
		await process.kill();
		expect(f.signals()).toBe("");
	});
	it("signals only the current live process group", async () => {
		const f = fixture();
		f.seed();
		await (await f.sandbox.getProcess("one"))!.kill();
		expect(f.signals()).toBe("-s 15 -- -123\n");
	});
});
