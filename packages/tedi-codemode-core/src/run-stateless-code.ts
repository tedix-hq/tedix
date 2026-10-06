import type {
	DynamicWorkerExecutor,
	ResolvedProvider,
} from "@cloudflare/codemode";

export interface StatelessCodeModeRunOptions {
	code: string;
	executor: DynamicWorkerExecutor;
	providers: ResolvedProvider[];
}

export interface StatelessCodeModeRunResult {
	result: unknown;
	logs?: string[];
	/**
	 * Error message surfaced by the Cloudflare codemode SDK. The SDK does NOT
	 * throw on a thrown JS/ReferenceError inside executed code — it returns
	 * `{ result: undefined, error: <msg>, logs }`. Callers MUST inspect this
	 * field and fail the run; otherwise a thrown sandbox error is silently
	 * shaped into `result: null`.
	 */
	error?: string;
}

function stripTrailingSemicolons(code: string): string {
	return code.trim().replace(/;+\s*$/, "");
}

/**
 * WorkerLoader can cross an execution boundary that preserves discovery
 * metadata as a plain object instead of a native Array. Normalize that inside
 * the sandbox so model-authored Code Mode can rely on the public
 * `discover.search(...).slice(...)` contract.
 */
export function wrapStatelessCodeModeSource(code: string): string {
	const userCode = stripTrailingSemicolons(code);
	return `async () => {
	const __tedixNormalizeDiscoveryArray = (value) => {
		if (Array.isArray(value)) return value;
		if (!value || typeof value !== "object") return value;
		const record = value;
		const __tedixArrayFromObjectified = (candidate) => {
			if (Array.isArray(candidate)) return candidate;
			if (!candidate || typeof candidate !== "object") return null;
			const candidateRecord = candidate;
			const candidateKeys = Object.keys(candidateRecord)
				.filter((key) => /^(0|[1-9]\\d*)$/.test(key))
				.sort((a, b) => Number(a) - Number(b));
			if (candidateKeys.length === 0) return null;
			return candidateKeys.map((key) => candidateRecord[key]);
		};
		const fromResults = __tedixArrayFromObjectified(record.results);
		const rows = fromResults ?? __tedixArrayFromObjectified(record);
		if (!Array.isArray(rows)) return value;
		const array = rows.slice();
		for (const [key, entry] of Object.entries(record)) {
			if (/^(0|[1-9]\\d*)$/.test(key) || key === "length") continue;
			array[key] =
				key === "results"
					? (__tedixArrayFromObjectified(entry) ?? entry)
					: entry;
		}
		if (!Array.isArray(array.results)) array.results = array;
		return array;
	};
	try {
		if (
			typeof discover === "object" &&
			discover &&
			typeof discover.search === "function"
		) {
			const __tedixDiscoverSearch = discover.search.bind(discover);
			discover.search = async (...args) =>
				__tedixNormalizeDiscoveryArray(await __tedixDiscoverSearch(...args));
		}
	} catch {
		// Discovery normalization is best-effort; user code should still run.
	}
	const __tedixUserCode = (${userCode});
	if (typeof __tedixUserCode !== "function") {
		throw new Error("Code Mode program must evaluate to a function");
	}
	return await __tedixUserCode();
}`;
}

/**
 * Run request-scoped Code Mode through the stable executor API.
 *
 * `@cloudflare/codemode@0.4.1` exposes durable runtime primitives,
 * `DynamicWorkerExecutor`, and a package-level `runCode` helper. Tedix
 * deliberately keeps stateless MCP execution on the executor boundary so
 * gateway, per-tedi, and muscle-memory paths share one import-safe contract.
 */
export async function runStatelessCodeMode({
	code,
	executor,
	providers,
}: StatelessCodeModeRunOptions): Promise<StatelessCodeModeRunResult> {
	const response = (await executor.execute(
		wrapStatelessCodeModeSource(code),
		providers,
	)) as StatelessCodeModeRunResult;
	// The SDK never throws on a sandbox JS/ReferenceError; it returns the error
	// on `response.error`. Forward it explicitly so every caller can fail the
	// run instead of shaping `undefined` into a silent `result: null`.
	return {
		result: response.result,
		...(response.logs ? { logs: response.logs } : {}),
		...(response.error ? { error: response.error } : {}),
	};
}
