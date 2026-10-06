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

/**
 * Add `disallow_importable_env` to every manifest crossing this Loader.
 * Covers both anonymous `load()` and named/cached `get()` Workers.
 */
export function withModelAuthoredCodeIsolation(
	loader: WorkerLoader,
): WorkerLoader {
	return {
		load: (code) => loader.load(hardenWorkerCode(code)),
		get: (name, getCode) =>
			loader.get(name, async () => hardenWorkerCode(await getCode())),
	};
}
