/**
 * Worker Loader boundary for code authored by a model.
 *
 * The native DynamicWorkerExecutor owns code execution and RPC wiring.
 * Decorating its Loader ensures every model-authored Worker hides its imported
 * environment, including named/cached Workers. Outbound policy and explicit
 * capability bindings remain owned by each caller's manifest.
 */

export const MODEL_AUTHORED_CODE_FLAG = "disallow_importable_env";

function hardenWorkerCode(
	code: WorkerLoaderWorkerCode,
): WorkerLoaderWorkerCode {
	const compatibilityFlags = new Set(code.compatibilityFlags ?? []);
	compatibilityFlags.add(MODEL_AUTHORED_CODE_FLAG);
	return {
		...code,
		compatibilityFlags: [...compatibilityFlags],
	};
}

/** Fixed trusted host dimensions; no invocation or customer values. */
export type ModelAuthoredLoaderHost =
	| {
			surface: "gateway_model_code";
			reason: "gateway_model_authored_invocation";
	  }
	| { surface: "stored_tool_code"; reason: "stored_tool_authored_invocation" }
	| {
			surface: "tedi_stateless_mcp_code";
			reason: "tedi_stateless_authored_invocation";
	  }
	| {
			surface: "tedi_durable_code";
			reason: "tedi_durable_authored_invocation";
	  };

function capturedHost(
	host: ModelAuthoredLoaderHost | undefined,
): ModelAuthoredLoaderHost | undefined {
	try {
		if (
			!host ||
			Reflect.ownKeys(host).length !== 2 ||
			!Object.hasOwn(host, "surface") ||
			!Object.hasOwn(host, "reason")
		)
			return;
		const { surface, reason } = host;
		if (
			(surface === "gateway_model_code" &&
				reason === "gateway_model_authored_invocation") ||
			(surface === "stored_tool_code" &&
				reason === "stored_tool_authored_invocation") ||
			(surface === "tedi_stateless_mcp_code" &&
				reason === "tedi_stateless_authored_invocation") ||
			(surface === "tedi_durable_code" &&
				reason === "tedi_durable_authored_invocation")
		)
			return { surface, reason } as ModelAuthoredLoaderHost;
	} catch {
		/* Invalid diagnostic labels never affect isolation or execution. */
	}
}

/** Synchronous best effort: counts host calls, not provider creations or billing. */
function emitLoaderCall(
	host: ModelAuthoredLoaderHost | undefined,
	method: "load" | "get",
	identity: "anonymous" | "named",
	phase: "attempted" | "returned" | "threw",
): void {
	if (!host) return;
	try {
		console.log(
			JSON.stringify({
				event: "tedix.dynamic_worker.loader_call",
				version: 1,
				surface: host.surface,
				reason: host.reason,
				method,
				identity,
				phase,
			}),
		);
	} catch {
		/* A log sink cannot change the native result or error. */
	}
}

/**
 * Add `disallow_importable_env` to anonymous and named/cached manifests.
 * Production constructors supply trusted host labels. Isolation-only callers
 * may omit diagnostics; malformed labels omit events, never execution.
 */
export function withModelAuthoredCodeIsolation(
	loader: WorkerLoader,
	host?: ModelAuthoredLoaderHost,
): WorkerLoader {
	const fixed = capturedHost(host);
	return {
		load: (code) => {
			const hardened = hardenWorkerCode(code);
			emitLoaderCall(fixed, "load", "anonymous", "attempted");
			try {
				const stub = loader.load(hardened);
				emitLoaderCall(fixed, "load", "anonymous", "returned");
				return stub;
			} catch (error) {
				emitLoaderCall(fixed, "load", "anonymous", "threw");
				throw error;
			}
		},
		get: (name, getCode) => {
			const wrapped = async () => hardenWorkerCode(await getCode());
			const identity = name === null ? "anonymous" : "named";
			emitLoaderCall(fixed, "get", identity, "attempted");
			try {
				const stub = loader.get(name, wrapped);
				emitLoaderCall(fixed, "get", identity, "returned");
				return stub;
			} catch (error) {
				emitLoaderCall(fixed, "get", identity, "threw");
				throw error;
			}
		},
	};
}
