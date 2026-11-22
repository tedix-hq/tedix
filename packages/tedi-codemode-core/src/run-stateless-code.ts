import {
	type DynamicWorkerExecutor,
	type ResolvedProvider,
	sanitizeToolName,
	ToolDispatcher,
} from "@cloudflare/codemode";

export interface StatelessCodeModeRunOptions {
	code: string;
	executor: DynamicWorkerExecutor;
	providers: ResolvedProvider[];
	/** Match the executor's timeout to enable literal single-call dispatch. */
	timeoutMs?: number;
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
	// Linear scan: a `/;+\s*$/` regex rescans each `;` run on hostile input.
	const trimmed = code.trim();
	let end = trimmed.length;
	while (end > 0 && trimmed[end - 1] === ";") end -= 1;
	return trimmed.slice(0, end);
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
		throw new Error('Code Mode program must evaluate to a function. Wrap the statements: async () => { return await discover.search({ query: "...", limit: 3 }); }');
	}
	return await __tedixUserCode();
}`;
}

/**
 * Run request-scoped Code Mode through the stable executor API.
 *
 * `@cloudflare/codemode@0.5.6` exposes durable runtime primitives,
 * `DynamicWorkerExecutor`, and a package-level `runCode` helper. Tedix
 * shares the request-local providers between literal single-tool dispatch and
 * sandbox execution so both paths retain the same tool authorization.
 */
export async function runStatelessCodeMode({
	code,
	executor,
	providers,
	timeoutMs,
}: StatelessCodeModeRunOptions): Promise<StatelessCodeModeRunResult> {
	const direct =
		timeoutMs === undefined ? undefined : literalToolCall(code, providers);
	if (direct) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				new ToolDispatcher({ call: direct.fn }).call("call", direct.args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Execution timed out")),
						timeoutMs,
					);
				}),
			]);
			const decoded = JSON.parse(response, decodeBinaryResult);
			return {
				result: decoded.result,
				...(decoded.error ? { error: decoded.error } : {}),
				logs: [],
			};
		} catch (error) {
			return {
				result: undefined,
				error: error instanceof Error ? error.message : String(error),
				logs: [],
			};
		} finally {
			clearTimeout(timer);
		}
	}
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

function literalToolCall(code: string, providers: ResolvedProvider[]) {
	const source = stripTrailingSemicolons(code).trim();
	const prefix = /^async[ \t]*\(\s*\)\s*=>/.exec(source);
	if (!prefix) return;
	let body = source.slice(prefix[0].length).trim();
	if (body.startsWith("{")) {
		if (!body.endsWith("}")) return;
		body = body.slice(1, -1).trim();
		const returned = /^return[ \t]+(?=\S)/.exec(body);
		if (!returned) return;
		body = stripTrailingSemicolons(body.slice(returned[0].length)).trim();
	}
	const match =
		/^(?:await\s+)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(
			body.trim(),
		);
	if (!match) return;
	const [, namespace, tool, argument = ""] = match;
	const matching = providers.filter((provider) => provider.name === namespace);
	const provider = matching[0];
	if (matching.length !== 1 || !provider || provider.prelude) return;
	const functions = Object.entries(provider.fns).filter(
		([name]) => sanitizeToolName(name) === tool,
	);
	const entry = functions[0];
	if (functions.length !== 1 || !entry) return;
	try {
		// Parse data only. Expressions, extra calls and statements stay sandboxed.
		const args = argument.trim()
			? [
					JSON.parse(argument, (key, value) => {
						if (key === "__proto__")
							throw new Error(
								"Prototype literal requires JavaScript semantics",
							);
						return value;
					}),
				]
			: [];
		return { fn: entry[1], args: JSON.stringify(args) };
	} catch {
		return;
	}
}

function decodeBinaryResult(_key: string, value: unknown): unknown {
	if (
		!value ||
		typeof value !== "object" ||
		!("__codemode_binary_v1__" in value) ||
		!("data" in value) ||
		typeof value.data !== "string"
	)
		return value;
	const bytes = Uint8Array.from(atob(value.data), (char) => char.charCodeAt(0));
	return value.__codemode_binary_v1__ === "ArrayBuffer" ? bytes.buffer : bytes;
}
