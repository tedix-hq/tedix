import type {
	SandboxLimits,
	SandboxRunInput,
	SandboxRunResult,
	WorkspaceJson,
	WorkspaceSandbox,
} from "./index";
import type { WorkspaceBindingRegistry } from "./bindings";

/**
 * The Worker Loader surface this module uses. Cloudflare's `LOADER` binding
 * and workerd's `workerLoader` binding both have it.
 */
export interface SandboxLoader {
	load(code: WorkerLoaderWorkerCode): {
		getEntrypoint<T = unknown>(name?: string): T;
	};
}

interface SandboxEntrypoint {
	verify(): Promise<void>;
	run(
		bindings: Record<string, unknown>,
		maxLogLines: number,
	): Promise<{
		ok: boolean;
		value?: string;
		error?: string;
		logs: string[];
	}>;
}

export const SANDBOX_COMPATIBILITY_DATE = "2026-10-01";

export const SANDBOX_DEFAULT_LIMITS: Required<SandboxLimits> = {
	timeoutMs: 30_000,
	maxResultChars: 200_000,
	maxLogLines: 200,
};

/**
 * The module that hosts a snippet. It imports the snippet as `agent.js`,
 * records console output, and returns the result as a JSON string so nothing
 * but plain data crosses back out of the isolate.
 */
const SANDBOX_HARNESS = `import { WorkerEntrypoint } from "cloudflare:workers";
import snippet from "agent.js";

function stringify(value) {
  if (value === undefined) return undefined;
  return JSON.stringify(value);
}

function describeError(error) {
  if (error instanceof Error) return error.stack || error.message || String(error);
  return String(error);
}

export default class extends WorkerEntrypoint {
  verify() {
    if (typeof snippet !== "function") {
      throw new TypeError("The snippet's default export must be a function");
    }
  }

  async run(bindings, maxLogLines) {
    // The bindings arrive as RPC arguments, not in the manifest env: a stub
    // can only cross an RPC call, and this way it lives exactly as long as
    // the run. The manifest env stays empty, so nothing outlives the call.
    const env = Object.assign({}, this.env, bindings);
    const logs = [];
    const record = (level) => (...args) => {
      if (logs.length >= maxLogLines) return;
      const text = args.map((a) => {
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(" ");
      logs.push(level + ": " + text);
    };
    const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    console.log = record("log");
    console.info = record("info");
    console.warn = record("warn");
    console.error = record("error");
    console.debug = record("debug");
    try {
      const value = await snippet(env);
      return { ok: true, value: stringify(value), logs };
    } catch (error) {
      return { ok: false, error: describeError(error), logs };
    } finally {
      Object.assign(console, original);
    }
  }
}
`;

/**
 * A snippet is either a module with a default export or a bare function body.
 * A body is wrapped so `env` is in scope and `return` works.
 */
export function moduleForSnippet(code: string): string {
	if (/^\s*export\s+default\b/m.test(code)) return code;
	return `export default async function (env) {\n${code}\n}\n`;
}

/**
 * Runs one snippet in a fresh isolate with no network. The manifest is built
 * here and nowhere else in this package, so `globalOutbound: null` and the
 * model-code isolation flag cannot be forgotten by a caller.
 */
export class LoaderWorkspaceSandbox implements WorkspaceSandbox {
	constructor(
		private readonly loader: SandboxLoader,
		private readonly bindings: WorkspaceBindingRegistry,
	) {}

	async run(input: SandboxRunInput): Promise<SandboxRunResult> {
		const limits = { ...SANDBOX_DEFAULT_LIMITS, ...input.limits };
		const started = Date.now();
		const elapsed = () => Date.now() - started;

		// `env` carries no bindings: stubs cannot be serialized into a manifest,
		// so they travel as the argument of the harness's `run` call instead.
		// `globalOutbound: null` is the whole point: the loaded code gets no
		// `fetch` to the internet and reaches only what `run` hands it.
		const manifest: WorkerLoaderWorkerCode = {
			compatibilityDate: SANDBOX_COMPATIBILITY_DATE,
			compatibilityFlags: [
				// Model-authored code must not import its env or call back into
				// itself through ctx.exports.
				"disallow_importable_env",
			],
			mainModule: "harness.js",
			modules: {
				"harness.js": SANDBOX_HARNESS,
				"agent.js": moduleForSnippet(input.code),
			},
			env: {},
			globalOutbound: null,
		};

		let entrypoint: SandboxEntrypoint;
		let bindings: Record<string, unknown>;
		try {
			bindings = this.bindings.env(input.bindings);
			entrypoint = this.loader
				.load(manifest)
				.getEntrypoint<SandboxEntrypoint>();
			await entrypoint.verify();
		} catch (error) {
			return {
				ok: false,
				reason: "load",
				error: describeError(error),
				logs: [],
				durationMs: elapsed(),
			};
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), limits.timeoutMs);
		});
		try {
			const outcome = await Promise.race([
				entrypoint.run(bindings, limits.maxLogLines),
				timeout,
			]);
			if (outcome === "timeout") {
				return {
					ok: false,
					reason: "timeout",
					error: `The snippet did not finish within ${limits.timeoutMs} ms`,
					logs: [],
					durationMs: elapsed(),
				};
			}
			if (!outcome.ok) {
				return {
					ok: false,
					reason: "error",
					error: outcome.error ?? "The snippet threw",
					logs: outcome.logs,
					durationMs: elapsed(),
				};
			}
			return {
				ok: true,
				...decodeResult(outcome.value, limits.maxResultChars),
				logs: outcome.logs,
				durationMs: elapsed(),
			};
		} catch (error) {
			return {
				ok: false,
				reason: "error",
				error: describeError(error),
				logs: [],
				durationMs: elapsed(),
			};
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

function decodeResult(
	serialized: string | undefined,
	maxResultChars: number,
): { value: WorkspaceJson | undefined; truncated: boolean } {
	if (serialized === undefined) return { value: undefined, truncated: false };
	if (serialized.length > maxResultChars) {
		return { value: serialized.slice(0, maxResultChars), truncated: true };
	}
	return { value: JSON.parse(serialized) as WorkspaceJson, truncated: false };
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.stack || error.message;
	return String(error);
}
