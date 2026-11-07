/**
 * Runs model-authored code in a fresh Worker with no network: the only
 * things it can reach are the RPC stubs placed in its `env`. Each stub is a
 * loopback into this workspace object, where the wrapped binding runs.
 */
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import type {
	SandboxRunInput,
	SandboxRunResult,
	WorkspaceSandbox,
} from "./runtime";

export const SANDBOX_TIMEOUT_MS = 60_000;

/**
 * Entry module of the sandbox Worker. It imports the model's module,
 * captures console output, runs the default export with `env`, and returns
 * `{result, logs, error}` over RPC. Any throw becomes `error`.
 */
export const SANDBOX_HARNESS = `
import { WorkerEntrypoint } from "cloudflare:workers";
import * as agent from "./agent.js";
const MAX_LOGS = 200;
function show(value) {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}
// Each env binding answers { ok, value | error }; the model's code gets a value or a throw.
function unwrap(env) {
	const out = {};
	for (const [name, stub] of Object.entries(env)) {
		out[name] = new Proxy({}, {
			get(_target, method) {
				if (typeof method !== "string") return undefined;
				return async (...args) => {
					const outcome = await stub[method](...args);
					if (outcome && outcome.ok === true) return outcome.value;
					throw new Error((outcome && outcome.error) || (name + "." + method + " failed"));
				};
			},
		});
	}
	return out;
}
export default class extends WorkerEntrypoint {
	// Binding stubs arrive as the RPC argument: a loader manifest env cannot carry them.
	async run(env) {
		const logs = [];
		const capture = (...args) => { if (logs.length < MAX_LOGS) logs.push(args.map(show).join(" ")); };
		for (const level of ["log", "info", "warn", "error", "debug"]) console[level] = capture;
		try {
			const main = agent.default;
			if (typeof main !== "function") throw new Error("Module must export default async (env) => …");
			const result = await main(unwrap(env ?? {}));
			return { ok: true, result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)), logs };
		} catch (error) {
			return { ok: false, logs, error: error instanceof Error ? error.message : String(error) };
		}
	}
}
`;

interface SandboxEntrypoint {
	run(
		env: Record<string, unknown>,
	): Promise<Omit<SandboxRunResult, "durationMs">>;
	[Symbol.dispose]?(): void;
}

export function createLoaderSandbox(
	loader: WorkerLoader,
	compatibilityDate: string,
): WorkspaceSandbox {
	const isolated = withModelAuthoredCodeIsolation(loader, {
		surface: "workspace_object_code",
		reason: "workspace_turn_code",
	});
	return {
		async run(input: SandboxRunInput): Promise<SandboxRunResult> {
			const started = Date.now();
			const worker = isolated.load({
				compatibilityDate,
				compatibilityFlags: ["disallow_importable_env"],
				mainModule: "harness.js",
				modules: { "harness.js": SANDBOX_HARNESS, "agent.js": input.code },
				// Stubs travel on the run() call; the manifest env stays empty.
				env: {},
				// No network: the sandbox reaches the workspace only through env stubs.
				globalOutbound: null,
			});
			const entrypoint = worker.getEntrypoint() as unknown as SandboxEntrypoint;
			const timeoutMs = input.timeoutMs ?? SANDBOX_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const outcome = await Promise.race([
					entrypoint.run(input.env),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(new Error(`Sandbox timed out after ${timeoutMs} ms`)),
							timeoutMs,
						);
					}),
				]);
				return { ...outcome, durationMs: Date.now() - started };
			} catch (error) {
				return {
					ok: false,
					logs: [],
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - started,
				};
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
