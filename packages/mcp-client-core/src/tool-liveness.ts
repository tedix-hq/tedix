/**
 * Classify tool calls as discovery or execution and identify successful
 * execution evidence for API child-run reads and kernel route evaluation.
 * Discovery alone does not establish task execution; callers own completion
 * and recovery decisions.
 */

/** Meta tools that only inspect the tool catalog — never task execution. */
const DISCOVERY_TOOL_NAMES = new Set([
	"tedix_mcp_list_namespaces",
	"tedix_mcp_search_tools",
]);

/**
 * Code Mode receivers that are discovery / language scaffolding, not a task tool
 * call. A `namespace.tool(...)` on anything NOT in this set is real execution.
 */
const NON_EXECUTION_RECEIVERS = new Set([
	"discover",
	"console",
	"JSON",
	"Object",
	"Math",
	"Array",
	"Promise",
	"String",
	"Number",
	"Date",
	"Boolean",
	"Map",
	"Set",
]);

/** `receiver.method(` — a candidate namespaced tool invocation inside code. */
const NAMESPACE_CALL_RE = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;

/** Extract the actual Code Mode source instead of scanning serialized JSON. */
function codeSourceFromArgs(argsJson: string): string {
	try {
		const parsed = JSON.parse(argsJson) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const code = (parsed as Record<string, unknown>).code;
			if (typeof code === "string") return code;
		}
	} catch {
		// Keep the classifier deterministic and fail-soft for malformed telemetry.
	}
	return argsJson;
}

/**
 * Remove comments and string/template literal bodies before scanning calls.
 * Tool names mentioned in prompts, logs, or comments are not execution.
 */
function stripStringsAndComments(source: string): string {
	let output = "";
	let state: "code" | "single" | "double" | "template" | "line" | "block" =
		"code";
	let escaped = false;
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i] ?? "";
		const next = source[i + 1] ?? "";
		if (state === "code") {
			if (char === "/" && next === "/") {
				state = "line";
				output += "  ";
				i += 1;
			} else if (char === "/" && next === "*") {
				state = "block";
				output += "  ";
				i += 1;
			} else if (char === "'") {
				state = "single";
				output += " ";
			} else if (char === '"') {
				state = "double";
				output += " ";
			} else if (char === "`") {
				state = "template";
				output += " ";
			} else {
				output += char;
			}
			continue;
		}
		if (state === "line") {
			if (char === "\n") {
				state = "code";
				output += "\n";
			} else output += " ";
			continue;
		}
		if (state === "block") {
			if (char === "*" && next === "/") {
				state = "code";
				output += "  ";
				i += 1;
			} else output += char === "\n" ? "\n" : " ";
			continue;
		}
		if (escaped) {
			escaped = false;
			output += " ";
			continue;
		}
		if (char === "\\") {
			escaped = true;
			output += " ";
			continue;
		}
		const closes =
			(state === "single" && char === "'") ||
			(state === "double" && char === '"') ||
			(state === "template" && char === "`");
		if (closes) state = "code";
		output += char === "\n" ? "\n" : " ";
	}
	return output;
}

/** Local result variables use Array/Object methods; they are not namespaces. */
function localIdentifiers(source: string): Set<string> {
	const identifiers = new Set<string>();
	for (const match of source.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g,
	)) {
		if (match[1]) identifiers.add(match[1]);
	}
	for (const match of source.matchAll(
		/(?:async\s+)?\(([^()]*)\)\s*=>|\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g,
	)) {
		if (match[2]) identifiers.add(match[2]);
		for (const parameter of (match[1] ?? "").split(",")) {
			for (const identifier of parameter.matchAll(/[A-Za-z_$][\w$]*/g)) {
				if (identifier[0]) identifiers.add(identifier[0]);
			}
		}
	}
	return identifiers;
}

/**
 * Does a `tedix_mcp_code` program invoke a real task tool (`namespace.tool(...)`
 * on a receiver that is not the discovery/scaffolding set)? Best-effort intent
 * detection over the serialized `{ code }` argument — deterministic, no eval.
 */
function codeInvokesTaskTool(argsJson: string): boolean {
	const source = stripStringsAndComments(codeSourceFromArgs(argsJson));
	const locals = localIdentifiers(source);
	NAMESPACE_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null = NAMESPACE_CALL_RE.exec(source);
	while (match !== null) {
		const receiver = match[1];
		if (
			receiver &&
			!NON_EXECUTION_RECEIVERS.has(receiver) &&
			!locals.has(receiver)
		) {
			return true;
		}
		match = NAMESPACE_CALL_RE.exec(source);
	}
	return false;
}

export type ToolCallKind = "discovery" | "execution";

/**
 * Classify ONE tool call as discovery vs execution from its name + serialized
 * arguments. `tedix_mcp_code` is dual-use: a program that only calls `discover.*`
 * is discovery; one that calls a real `namespace.tool(...)` is execution.
 */
export function classifyToolCall(name: string, argsJson: string): ToolCallKind {
	if (DISCOVERY_TOOL_NAMES.has(name)) return "discovery";
	// tedix_mcp_call_tool always invokes one named namespace.tool — execution.
	if (name === "tedix_mcp_call_tool") return "execution";
	if (name === "tedix_mcp_code") {
		return codeInvokesTaskTool(argsJson) ? "execution" : "discovery";
	}
	// Any other tool (a direct namespaced tool bound into the turn's tool set) is
	// itself an execution surface.
	return "execution";
}

export interface TurnToolCall {
	name: string;
	ok: boolean;
	kind: ToolCallKind;
}

/**
 * True when at least one EXECUTION tool call SUCCEEDED — concrete task evidence.
 * A failed execution attempt does not count (nothing was accomplished), and no
 * amount of discovery counts.
 */
export function hasExecutionEvidence(
	toolCalls: readonly TurnToolCall[],
): boolean {
	return toolCalls.some((c) => c.kind === "execution" && c.ok);
}
