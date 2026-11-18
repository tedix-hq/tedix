/**
 * Runs model-authored code in a fresh Worker with no network: the only
 * things it can reach are the RPC stubs placed in its `env`. Each stub is a
 * loopback into this workspace object, where the wrapped binding runs.
 */
import { loadAppRuntimeWorker } from "@tedix/api-contract/utils/app-runtime";
import { validateAppSource } from "@tedix/api-contract/utils/app-source-validation";
import {
	withDynamicWorkerLoaderDiagnostics,
	withModelAuthoredCodeIsolation,
} from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { callFailureText } from "./call-failure";
import type {
	SandboxRunInput,
	SandboxRunResult,
	WorkspaceSandbox,
} from "./runtime";

export const SANDBOX_TIMEOUT_MS = 60_000;

/**
 * A run whose time is up is no longer waited for. Nothing can halt a loaded
 * Worker, so its code may go on executing; the workspace refuses the calls it
 * makes from then on. The model is told that earlier calls may have applied.
 */
export function sandboxTimeoutError(timeoutMs: number): string {
	return `The code did not finish within ${Math.round(timeoutMs / 1000)} s, so its result is unknown. Calls it made before then may have taken effect; later ones are refused. Read the current state before you repeat a change, and split long work into shorter runs.`;
}

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
	try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
// What the model reads when its code throws: an Error's message, or the thrown value itself.
function failure(error) {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string" && error) return error;
	return "The code threw " + show(error).slice(0, 2000) + " instead of an Error";
}
// An RPC stub's own fetch is HTTP, so web.fetch travels as fetchPage.
const RPC_NAMES = Object.assign(Object.create(null), { fetch: "fetchPage" });
// Each env binding answers { ok, value | error }; the model's code gets a value or a throw.
function unwrap(env) {
	const out = {};
	for (const [name, stub] of Object.entries(env)) {
		out[name] = new Proxy({}, {
			get(_target, method) {
				if (typeof method !== "string") return undefined;
				return async (...args) => {
					const outcome = await stub[RPC_NAMES[method] ?? method](...args);
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
			return { ok: false, logs, error: failure(error) };
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
			const timeoutMs = input.timeoutMs ?? SANDBOX_TIMEOUT_MS;
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Whatever goes wrong with the model's code, loading it included, is
			// this run's result and never a throw: the turn goes on.
			try {
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
				const entrypoint =
					worker.getEntrypoint() as unknown as SandboxEntrypoint;
				const outcome = await Promise.race([
					entrypoint.run(input.env),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(sandboxTimeoutError(timeoutMs))),
							timeoutMs,
						);
					}),
				]);
				return { ...outcome, durationMs: Date.now() - started };
			} catch (error) {
				return {
					ok: false,
					logs: [],
					error: callFailureText(error),
					durationMs: Date.now() - started,
				};
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}

/** Use the same source checks and capability-free App dry-load as the API. */
export async function validateWorkspaceAppSource(
	loader: WorkerLoader,
	files: Record<string, string>,
	compatibilityDate?: unknown,
) {
	await validateAppSource(
		async (source, date) => {
			try {
				const worker = loadAppRuntimeWorker(
					withDynamicWorkerLoaderDiagnostics(loader, {
						surface: "workspace_app_validation",
						reason: "workspace_app_validation",
					}),
					`validate:${crypto.randomUUID()}`,
					source,
					{ compatibilityDate: date, validation: true },
				);
				return await worker
					.getEntrypoint()
					.fetch(new Request("https://validate/"));
			} catch (error) {
				return new Response(
					`server.js:1:1: App dry-load failed: ${error instanceof Error ? error.message : String(error)}`,
					{ status: 400 },
				);
			}
		},
		files,
		compatibilityDate,
	);
}
