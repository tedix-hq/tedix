import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject, RpcTarget } from "cloudflare:workers";

const PROCESS_ROOT = "/var/lib/tedix-processes";
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;

export type SandboxCommand = readonly [string, ...string[]] | string[];

export interface SandboxExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
}

export type NativeProcessStatus =
	| {
			state: "running";
			id?: string;
			pid?: number;
			command: readonly string[];
			startedAt: string;
	  }
	| {
			state: "starting";
			id?: string;
			pid?: number;
			command: readonly string[];
			startedAt: string;
			endedAt?: string;
	  }
	| {
			state: "exited";
			id?: string;
			pid?: number;
			command: readonly string[];
			startedAt: string;
			endedAt: string;
			exit: { code: number; timedOut: boolean; signal?: number };
	  }
	| {
			state: "error";
			id?: string;
			pid?: number;
			command: readonly string[];
			startedAt: string;
			endedAt: string;
			error: { message: string; code?: string };
	  };

export interface NativeProcessOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	signal?: number;
}

export interface NativeProcess {
	readonly id: string;
	status(): Promise<NativeProcessStatus>;
	output(options?: {
		encoding?: "utf8";
		maxBytes?: number;
		timeout?: number;
	}): Promise<NativeProcessOutput>;
	logSnapshot(): Promise<{
		stdout: string;
		stderr: string;
		truncated: boolean;
	}>;
	kill(signal?: number): Promise<void>;
	waitForExit(options?: { timeout?: number }): Promise<void>;
	waitForPort(port: number, options?: { timeout?: number }): Promise<void>;
}

type ProcessRecord = {
	id: string;
	command: string[];
	cwd: string;
	startedAt: string;
	timeoutMs: number | null;
};

type ProcessSnapshot = {
	record: ProcessRecord;
	state: "starting" | "running" | "exited" | "lost";
	pid?: number;
	exitCode?: number;
	endedAt?: string;
};

const RUN_SCRIPT = `dir=$1; timeout_ms=$2; shift 2
setsid sh -c '
  echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"
  if [ "$1" -gt 0 ]; then
    seconds=$(awk "BEGIN { print $1 / 1000 }")
    shift
    timeout -k 5 "$seconds" "$@"
  else
    shift
    exec "$@"
  fi
' "$dir" "$timeout_ms" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
code=$?
date -u +%Y-%m-%dT%H:%M:%S.%3NZ >"$dir/ended-at.tmp"
mv "$dir/ended-at.tmp" "$dir/ended-at"
echo "$code" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;

// A restored disk can contain a PID now owned by another process. Match the
// kernel boot identity in the same shell invocation as every liveness/signal check.
const CURRENT_PROCESS_SCRIPT = `current() {
  read -r pid boot 2>/dev/null <"$1/pid" &&
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ]
}`;

const STATUS_SCRIPT = `${CURRENT_PROCESS_SCRIPT}
dir=$1
[ -f "$dir/process.json" ] || exit 4
if [ -e "$dir/exit-code" ]; then printf 'exited %s\\n' "$(cat "$dir/exit-code")"
elif [ ! -e "$dir/pid" ]; then echo starting
elif current "$dir" && kill -0 "$pid" 2>/dev/null; then printf 'running %s\\n' "$pid"
elif [ -e "$dir/exit-code" ]; then printf 'exited %s\\n' "$(cat "$dir/exit-code")"
else echo lost
fi
cat "$dir/process.json"
printf '\\n'
[ ! -e "$dir/ended-at" ] || cat "$dir/ended-at"`;

const WAIT_SCRIPT = `${CURRENT_PROCESS_SCRIPT}
dir=$1; dead_checks=0
while [ ! -e "$dir/exit-code" ]; do
  if [ -e "$dir/pid" ]; then
    current "$dir" || exit 4
    # The child can exit before the supervisor writes its atomic exit record.
    if ! kill -0 "$pid" 2>/dev/null; then
      dead_checks=$((dead_checks + 1))
      [ "$dead_checks" -lt 25 ] || exit 4
    else
      dead_checks=0
    fi
  fi
  sleep 0.2
done`;

const KILL_SCRIPT = `${CURRENT_PROCESS_SCRIPT}
dir=$1; signal=$2
[ ! -e "$dir/exit-code" ] || exit 0
current "$dir" || exit 0
kill -0 "$pid" 2>/dev/null || exit 0
kill -s "$signal" -- "-$pid"`;

function processDirectory(id: string): string {
	if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id))
		throw new Error("Invalid process id");
	return `${PROCESS_ROOT}/${id}`;
}

function decode(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(buffer);
}

async function commandOutput(
	container: Container,
	command: string[],
	options: ContainerExecOptions = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const output = await (await container.exec(command, options)).output();
	return {
		exitCode: output.exitCode,
		stdout: decode(output.stdout),
		stderr: decode(output.stderr),
	};
}

class ProcessStore {
	constructor(
		private readonly container: Container,
		private readonly files: Files,
	) {}

	async start(
		id: string,
		command: SandboxCommand,
		options: SandboxExecOptions = {},
	): Promise<ManagedProcess> {
		const dir = processDirectory(id);
		await this.files.mkdir(PROCESS_ROOT, { recursive: true });
		try {
			await this.files.mkdir(dir);
		} catch (error) {
			if (!SandboxFileError.is(error) || error.code !== "EEXIST") throw error;
			throw new Error(`Process ${id} already exists`);
		}
		const record: ProcessRecord = {
			id,
			command: [...command],
			cwd: options.cwd ?? "/workspace",
			startedAt: new Date().toISOString(),
			timeoutMs: options.timeout ?? null,
		};
		try {
			await this.files.writeFile(`${dir}/process.json`, JSON.stringify(record));
			await this.container.exec(
				[
					"/bin/sh",
					"-c",
					RUN_SCRIPT,
					"tedix-run",
					dir,
					String(options.timeout ?? 0),
					...command,
				],
				{
					cwd: record.cwd,
					env: options.env,
					stdout: "ignore",
					stderr: "ignore",
				},
			);
		} catch (error) {
			await this.files.remove(dir, { recursive: true, force: true });
			throw error;
		}
		return new ManagedProcess(this, id);
	}

	async get(id: string): Promise<ManagedProcess | null> {
		return (await this.snapshot(id)) ? new ManagedProcess(this, id) : null;
	}

	async snapshot(id: string): Promise<ProcessSnapshot | null> {
		const dir = processDirectory(id);
		const result = await commandOutput(this.container, [
			"/bin/sh",
			"-c",
			STATUS_SCRIPT,
			"status",
			dir,
		]);
		if (result.exitCode === 4) return null;
		if (result.exitCode !== 0)
			throw new Error(result.stderr || "Process status failed");
		const [statusLine = "lost", recordLine = "{}", endedAt] =
			result.stdout.split("\n");
		const record = JSON.parse(recordLine) as ProcessRecord;
		const [state, value] = statusLine.split(" ");
		if (state === "running") return { record, state, pid: Number(value) };
		if (state === "starting") return { record, state };
		if (state === "exited") {
			return {
				record,
				state,
				exitCode: Number(value),
				endedAt: endedAt || undefined,
			};
		}
		return { record, state: "lost", endedAt: endedAt || undefined };
	}

	async status(id: string): Promise<NativeProcessStatus> {
		const snapshot = await this.snapshot(id);
		if (!snapshot) throw new Error(`Process ${id} was not found`);
		const base = {
			command: snapshot.record.command,
			startedAt: snapshot.record.startedAt,
		};
		if (snapshot.state === "running" || snapshot.state === "starting") {
			return { ...base, state: snapshot.state };
		}
		const endedAt = snapshot.endedAt ?? new Date().toISOString();
		if (snapshot.state === "lost") {
			return {
				...base,
				state: "error",
				endedAt,
				error: {
					message: "Process ended without an exit record",
					code: "PROCESS_LOST",
				},
			};
		}
		const code = snapshot.exitCode ?? 1;
		return {
			...base,
			state: "exited",
			endedAt,
			exit: { code, timedOut: code === 124 },
		};
	}

	async wait(id: string, timeout = 60_000): Promise<void> {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeout);
		try {
			const result = await commandOutput(
				this.container,
				["/bin/sh", "-c", WAIT_SCRIPT, "wait", processDirectory(id)],
				{ signal: abort.signal },
			);
			if (result.exitCode !== 0)
				throw new Error(`Process ${id} outcome is unavailable`);
		} catch (error) {
			if (abort.signal.aborted) throw new ProcessWaitTimeoutError(timeout);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	async kill(id: string, signal = 15): Promise<void> {
		const snapshot = await this.snapshot(id);
		if (!snapshot || snapshot.state !== "running" || !snapshot.pid) return;
		const result = await commandOutput(this.container, [
			"/bin/sh",
			"-c",
			KILL_SCRIPT,
			"kill",
			processDirectory(id),
			String(signal),
		]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr || `Failed to kill ${id}`);
	}

	async output(
		id: string,
		options: { maxBytes?: number; timeout?: number } = {},
	): Promise<NativeProcessOutput> {
		await this.wait(id, options.timeout ?? 10 * 60 * 1000);
		const status = await this.status(id);
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		const read = async (name: string) => {
			const response = await this.files.readFile(
				`${processDirectory(id)}/${name}`,
			);
			const bytes = new Uint8Array(await response.arrayBuffer());
			const truncated = bytes.byteLength > maxBytes;
			return {
				text: new TextDecoder().decode(
					truncated ? bytes.slice(-maxBytes) : bytes,
				),
				truncated,
			};
		};
		const [stdout, stderr] = await Promise.all([
			read("stdout.log"),
			read("stderr.log"),
		]);
		return {
			exitCode: status.state === "exited" ? status.exit.code : 1,
			stdout: stdout.text,
			stderr: stderr.text,
			truncated: stdout.truncated || stderr.truncated,
			timedOut: status.state === "exited" && status.exit.timedOut,
		};
	}

	async logSnapshot(
		id: string,
	): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
		// A status probe must not wait for a long-running build to exit. Read the
		// files as they exist now, keeping the RPC result bounded.
		const read = async (name: string) => {
			const result = await commandOutput(this.container, [
				"/bin/sh",
				"-c",
				`file=$1; limit=$2
[ -f "$file" ] || exit 0
bytes=$(wc -c < "$file")
[ "$bytes" -le "$limit" ] || printf truncated >&2
tail -c "$limit" "$file"`,
				"log-tail",
				`${processDirectory(id)}/${name}`,
				String(LOG_TAIL_BYTES),
			]);
			if (result.exitCode !== 0)
				throw new Error(result.stderr || `Failed to read ${name}`);
			return { text: result.stdout, truncated: result.stderr === "truncated" };
		};
		const [stdout, stderr] = await Promise.all([
			read("stdout.log"),
			read("stderr.log"),
		]);
		return {
			stdout: stdout.text,
			stderr: stderr.text,
			truncated: stdout.truncated || stderr.truncated,
		};
	}

	async waitForPort(port: number, timeout = 60_000): Promise<void> {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			try {
				const response = await this.container
					.getTcpPort(port)
					.fetch(new Request("http://container/", { method: "HEAD" }));
				await response.body?.cancel();
				if (response.status < 500) return;
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`Port ${port} did not become ready within ${timeout}ms`);
	}
}

export class ProcessWaitTimeoutError extends Error {
	constructor(readonly timeout: number) {
		super(`Process did not exit within ${timeout}ms`);
		this.name = "ProcessWaitTimeoutError";
	}
}

export class ManagedProcess extends RpcTarget {
	constructor(
		private readonly store: ProcessStore,
		readonly id: string,
	) {
		super();
	}

	status(): Promise<NativeProcessStatus> {
		return this.store.status(this.id);
	}

	output(options?: { encoding?: "utf8"; maxBytes?: number; timeout?: number }) {
		return this.store.output(this.id, options);
	}

	logSnapshot() {
		return this.store.logSnapshot(this.id);
	}

	kill(signal?: number): Promise<void> {
		return this.store.kill(this.id, signal);
	}

	waitForExit(options: { timeout?: number } = {}): Promise<void> {
		return this.store.wait(this.id, options.timeout);
	}

	waitForPort(port: number, options: { timeout?: number } = {}): Promise<void> {
		return this.store.waitForPort(port, options.timeout);
	}
}

export abstract class NativeContainerSandbox<Env> extends DurableObject<Env> {
	protected readonly container: Container;
	protected readonly files: Files;
	readonly #processes: ProcessStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		if (!container) throw new Error("Container attachment is unavailable");
		this.container = container;
		this.files = new Files(container);
		this.#processes = new ProcessStore(container, this.files);
		if (container.running) {
			void ctx.blockConcurrencyWhile(() =>
				container.setInactivityTimeout(this.inactivityTimeoutMs),
			);
		}
	}

	protected get inactivityTimeoutMs(): number {
		return 10 * 60 * 1000;
	}

	protected abstract startOptions(): ContainerStartupOptions;
	protected abstract get containerTelemetrySurface(): string;

	protected async startContainer(): Promise<void> {
		this.container.start(this.startOptions());
	}

	protected async configureContainer(): Promise<void> {}

	protected async afterContainerAccess(): Promise<void> {}

	protected async ensureContainer(): Promise<void> {
		if (this.container.running) {
			await this.afterContainerAccess();
			return;
		}
		const startedAt = Date.now();
		try {
			await this.startContainer();
			await this.configureContainer();
			await this.container.setInactivityTimeout(this.inactivityTimeoutMs);
			await this.afterContainerAccess();
			console.info({
				component: "tedix.container.runtime",
				event: "container.ready",
				surface: this.containerTelemetrySurface,
				durationMs: Date.now() - startedAt,
			});
		} catch (error) {
			console.error({
				component: "tedix.container.runtime",
				event: "container.start_failed",
				surface: this.containerTelemetrySurface,
				durationMs: Date.now() - startedAt,
			});
			throw error;
		}
	}

	async exec(command: SandboxCommand, options: SandboxExecOptions = {}) {
		await this.ensureContainer();
		return this.#processes.start(crypto.randomUUID(), command, options);
	}

	async startProcess(
		id: string,
		command: SandboxCommand,
		options: SandboxExecOptions = {},
	) {
		await this.ensureContainer();
		return this.#processes.start(id, command, options);
	}

	async getProcess(id: string) {
		if (!this.container.running) return null;
		return this.#processes.get(id);
	}

	async deleteProcess(id: string): Promise<void> {
		if (!this.container.running) return;
		await this.files.remove(processDirectory(id), {
			recursive: true,
			force: true,
		});
	}

	async readFile(
		path: string,
		options: { encoding: "none" },
	): Promise<{ content: Uint8Array; size: number }>;
	async readFile(
		path: string,
		options?: { encoding?: "utf8" },
	): Promise<{ content: string; size: number }>;
	async readFile(
		path: string,
		options: { encoding?: "utf8" | "none" } = {},
	): Promise<{ content: string | Uint8Array; size: number }> {
		await this.ensureContainer();
		const response = await this.files.readFile(path);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const content =
			options.encoding === "none" ? bytes : new TextDecoder().decode(bytes);
		return { content, size: bytes.byteLength };
	}

	async writeFile(
		path: string,
		content: string | ArrayBuffer | ArrayBufferView | Blob,
	) {
		await this.ensureContainer();
		await this.files.writeFile(path, content);
	}

	async mkdir(path: string, options: { recursive?: boolean } = {}) {
		await this.ensureContainer();
		await this.files.mkdir(path, options);
	}

	async deleteFile(path: string) {
		await this.ensureContainer();
		await this.files.remove(path, { recursive: true, force: true });
	}

	async pathExists(path: string): Promise<boolean> {
		await this.ensureContainer();
		try {
			await this.files.stat(path);
			return true;
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return false;
			throw error;
		}
	}

	async renamePath(from: string, to: string): Promise<void> {
		await this.ensureContainer();
		const result = await commandOutput(this.container, ["mv", "--", from, to]);
		if (result.exitCode !== 0)
			throw new Error(result.stderr || "Rename failed");
	}

	async listFiles(
		path: string,
		options: { recursive?: boolean; includeHidden?: boolean } = {},
	) {
		await this.ensureContainer();
		const entries: Array<{
			path: string;
			relativePath: string;
			type: string;
			size?: number;
		}> = [];
		const walk = async (directory: string) => {
			for (const entry of await this.files.readDirectory(directory)) {
				const child = `${directory.replace(/\/$/, "")}/${entry.name}`;
				const info =
					entry.type === "file" ? await this.files.stat(child) : null;
				entries.push({
					path: child,
					relativePath: child.slice(path.replace(/\/$/, "").length + 1),
					type: entry.type,
					size: info?.size === undefined ? undefined : Number(info.size),
				});
				if (options.recursive && entry.type === "directory") await walk(child);
			}
		};
		await walk(path);
		return entries;
	}

	async containerFetch(
		input: Request | string,
		init?: RequestInit | number,
		port = 3000,
	) {
		await this.ensureContainer();
		const requestInit = typeof init === "number" ? undefined : init;
		const targetPort = typeof init === "number" ? init : port;
		return this.container
			.getTcpPort(targetPort)
			.fetch(
				input instanceof Request ? input : new Request(input, requestInit),
			);
	}

	async destroy(): Promise<void> {
		if (this.container.running) await this.container.destroy();
	}

	isRuntimeActive(): boolean {
		return this.container.running;
	}
}
