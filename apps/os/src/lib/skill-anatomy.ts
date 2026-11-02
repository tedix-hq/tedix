import type {
	SkillEntry,
	SkillWorkflowStep,
} from "@tedix/api-contract/schemas/cognitive";

export const WORKFLOW_SOURCE_PATH = "scripts/workflow.ts";
const SKILL_DOC_PATH = "SKILL.md";

/*
 * Workflow anatomy is a static reading of the saved revision. It never runs
 * anything: step call-sites come from `files["scripts/workflow.ts"]`, the
 * instruction outline comes from `content`, and recorded evidence is matched
 * afterwards by exact step name. Anything the source leaves to run time —
 * computed names, branches, helper functions called in a loop — is flagged
 * rather than smoothed over.
 */

export type SkillAnatomyMode = "workflow" | "instructions";

export type SkillAnatomyStepKind =
	| "action"
	| "sleep"
	| "sleep_until"
	| "wait"
	| "operation"
	| "instruction";

export type SkillAnatomyStep = {
	/** Stable within one derivation; used as a React key. */
	id: string;
	/** What the row is called: the literal name, or a `…`-pattern for dynamic names. */
	label: string;
	/** The statically-known step name, or null when the name is computed at run time. */
	name: string | null;
	kind: SkillAnatomyStepKind;
	sourcePath: string;
	/** 1-based line inside sourcePath. */
	line: number;
	/** Name is computed when the run executes. */
	dynamicName: boolean;
	/** Declared inside a loop; may run once per iteration. */
	repeated: boolean;
	/** Declared inside a branch; runs only when that branch is taken. */
	conditional: boolean;
	/** Runs alongside sibling steps inside Promise.all / race / allSettled / any. */
	parallel: boolean;
	/** A rollback handler is registered for this step. */
	hasRollback: boolean;
	/** Declared timeout literal, e.g. "15 seconds". */
	timeout: string | null;
	/** Declared retry limit, e.g. 3. */
	retryLimit: number | null;
	/** waitForEvent's declared event type. */
	eventType: string | null;
	/** sleep's declared duration literal, e.g. "10 seconds". */
	sleepDuration: string | null;
	/** Output marked sensitive in the step config. */
	sensitiveOutput: boolean;
	/** env.MCP calls inside the step body, "namespace.method". */
	toolCalls: string[];
	/** env.REASON / model judgment inside the step body. */
	usesModel: boolean;
	/** A fetch() inside the step body. */
	usesNetwork: boolean;
	/** For instruction steps: the declared instruction text. */
	detail: string | null;
};

export type SkillAnatomyInput = {
	name: string;
	required: boolean;
	type: string | null;
	description: string | null;
};

export type SkillAnatomy = {
	mode: SkillAnatomyMode;
	inputs: SkillAnatomyInput[];
	steps: SkillAnatomyStep[];
	/** Plain-English caveats that keep the reading honest. */
	notes: string[];
};

/* ------------------------------------------------------------------ */
/* Source masking: strings, templates and comments blanked to spaces   */
/* so structural scans never trip over parens inside a string literal. */
/* ------------------------------------------------------------------ */

type MaskMode = "code" | "expr" | "line" | "block" | "sq" | "dq" | "tpl";

function maskSource(source: string): string {
	const out = source.split("");
	const stack: { mode: MaskMode; depth: number }[] = [
		{ mode: "code", depth: 0 },
	];
	const top = () => stack[stack.length - 1]!;
	const blank = (index: number) => {
		if (out[index] !== "\n") out[index] = " ";
	};
	let i = 0;
	while (i < out.length) {
		const frame = top();
		const c = out[i]!;
		const n = out[i + 1];
		switch (frame.mode) {
			case "code":
			case "expr": {
				if (c === "/" && n === "/") {
					blank(i);
					blank(i + 1);
					stack.push({ mode: "line", depth: 0 });
					i += 2;
					continue;
				}
				if (c === "/" && n === "*") {
					blank(i);
					blank(i + 1);
					stack.push({ mode: "block", depth: 0 });
					i += 2;
					continue;
				}
				if (c === "'") {
					stack.push({ mode: "sq", depth: 0 });
					i++;
					continue;
				}
				if (c === '"') {
					stack.push({ mode: "dq", depth: 0 });
					i++;
					continue;
				}
				if (c === "`") {
					stack.push({ mode: "tpl", depth: 0 });
					i++;
					continue;
				}
				if (c === "{") frame.depth += 1;
				else if (c === "}") {
					if (frame.mode === "expr" && frame.depth === 0) {
						stack.pop();
						blank(i);
						i++;
						continue;
					}
					if (frame.depth > 0) frame.depth -= 1;
				}
				i++;
				continue;
			}
			case "line": {
				if (c === "\n") stack.pop();
				else blank(i);
				i++;
				continue;
			}
			case "block": {
				if (c === "*" && n === "/") {
					stack.pop();
					blank(i);
					blank(i + 1);
					i += 2;
					continue;
				}
				blank(i);
				i++;
				continue;
			}
			case "sq":
			case "dq": {
				const quote = frame.mode === "sq" ? "'" : '"';
				if (c === "\\") {
					blank(i);
					blank(i + 1);
					i += 2;
					continue;
				}
				blank(i);
				if (c === quote || c === "\n") stack.pop();
				i++;
				continue;
			}
			case "tpl": {
				if (c === "\\") {
					blank(i);
					blank(i + 1);
					i += 2;
					continue;
				}
				if (c === "`") {
					stack.pop();
					blank(i);
					i++;
					continue;
				}
				if (c === "$" && n === "{") {
					stack.push({ mode: "expr", depth: 0 });
					blank(i);
					blank(i + 1);
					i += 2;
					continue;
				}
				blank(i);
				i++;
				continue;
			}
		}
	}
	return out.join("");
}

/* ------------------------------------------------------------------ */
/* Structural helpers over the masked source                           */
/* ------------------------------------------------------------------ */

function matchParen(masked: string, openIndex: number): number {
	let depth = 0;
	for (let i = openIndex; i < masked.length; i++) {
		if (masked[i] === "(") depth += 1;
		else if (masked[i] === ")") {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Top-level argument spans inside one call's parentheses (masked). */
function splitArgs(
	masked: string,
	open: number,
	close: number,
): { start: number; end: number }[] {
	const args: { start: number; end: number }[] = [];
	let depth = 0;
	let argStart = open + 1;
	for (let i = open + 1; i < close; i++) {
		const c = masked[i];
		if (c === "(" || c === "[" || c === "{") depth += 1;
		else if (c === ")" || c === "]" || c === "}") depth -= 1;
		else if (c === "," && depth === 0) {
			args.push({ start: argStart, end: i });
			argStart = i + 1;
		}
	}
	if (masked.slice(argStart, close).trim().length > 0)
		args.push({ start: argStart, end: close });
	return args;
}

const LOOP_HEADER =
	/\bfor\s*\(|\bwhile\s*\(|\.(forEach|map|flatMap|filter|reduce|reduceRight|some|every|find|findIndex|findLast)\s*\(|\bdo\s*$/;
const BRANCH_HEADER = /\bif\s*\(|\belse\b|\bcatch\b|\bswitch\s*\(/;

type ScopeBlock = {
	start: number;
	end: number;
	loop: boolean;
	branch: boolean;
};

/**
 * `{`/`}` scope blocks with their opener's header classified. Semicolons only
 * split a header at paren depth 0, so a `for (…;…;…)` header survives.
 */
function scopeBlocks(masked: string): ScopeBlock[] {
	const blocks: ScopeBlock[] = [];
	const open: { index: number; loop: boolean; branch: boolean }[] = [];
	let parenDepth = 0;
	let boundary = 0;
	for (let i = 0; i < masked.length; i++) {
		const c = masked[i];
		if (c === "(") parenDepth += 1;
		else if (c === ")") parenDepth = Math.max(0, parenDepth - 1);
		else if (c === ";" && parenDepth === 0) boundary = i + 1;
		else if (c === "{") {
			const header = masked.slice(boundary, i);
			open.push({
				index: i,
				loop: LOOP_HEADER.test(header),
				branch: BRANCH_HEADER.test(header),
			});
			boundary = i + 1;
		} else if (c === "}") {
			const block = open.pop();
			if (block) {
				blocks.push({
					start: block.index,
					end: i,
					loop: block.loop,
					branch: block.branch,
				});
			}
			boundary = i + 1;
		}
	}
	return blocks;
}

function enclosing(
	blocks: ScopeBlock[],
	index: number,
): { loop: boolean; branch: boolean } {
	let loop = false;
	let branch = false;
	for (const block of blocks) {
		if (block.start < index && index < block.end) {
			loop ||= block.loop;
			branch ||= block.branch;
		}
	}
	return { loop, branch };
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i++)
		if (source[i] === "\n") line += 1;
	return line;
}

/* ------------------------------------------------------------------ */
/* Step argument reading                                               */
/* ------------------------------------------------------------------ */

const unescapeName = (raw: string) => raw.replace(/\\(['"\\`])/g, "$1");

/**
 * Classify the first argument of a step call. Literal strings give the
 * recorded step name; template literals render as a `…` pattern; anything
 * else is a computed name the run decides.
 */
function classifyName(raw: string): {
	name: string | null;
	label: string;
	dynamic: boolean;
} {
	const arg = raw.trim();
	const quoted = /^(['"])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(arg);
	if (quoted)
		return {
			name: unescapeName(quoted[2]!),
			label: unescapeName(quoted[2]!),
			dynamic: false,
		};
	const template = /^`((?:\\.|[^`\\])*)`$/s.exec(arg);
	if (template) {
		const body = template[1]!;
		if (!body.includes("${")) {
			const name = unescapeName(body);
			return { name, label: name, dynamic: false };
		}
		const pattern = body
			.replace(/\$\{[^}]*\}/g, "…")
			.replace(/\\(['"\\`])/g, "$1");
		return {
			name: null,
			label: pattern.trim().length > 0 ? pattern : "…",
			dynamic: true,
		};
	}
	const compact = arg.replace(/\s+/g, " ");
	return {
		name: null,
		label: compact.length > 0 ? compact.slice(0, 60) : "…",
		dynamic: true,
	};
}

const stringProp = (raw: string, prop: string): string | null => {
	const match = new RegExp(
		`${prop}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`,
	).exec(raw);
	return match ? match[2]! : null;
};

const retryLimit = (raw: string): number | null => {
	const match = /retries\s*:\s*\{[^}]*\blimit\s*:\s*(\d+)/s.exec(raw);
	return match ? Number(match[1]) : null;
};

function stepKind(method: string): SkillAnatomyStepKind {
	switch (method) {
		case "do":
			return "action";
		case "sleep":
			return "sleep";
		case "sleepUntil":
			return "sleep_until";
		case "waitForEvent":
			return "wait";
		default:
			return "operation";
	}
}

const TOOL_CALL = /env\.MCP\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;

function innerCalls(body: string): {
	toolCalls: string[];
	usesModel: boolean;
	usesNetwork: boolean;
} {
	const calls = new Set<string>();
	for (const match of body.matchAll(TOOL_CALL))
		calls.add(`${match[1]}.${match[2]}`);
	return {
		toolCalls: [...calls].sort(),
		usesModel: /\benv\.REASON\.|\brun_tedi_turn\b/.test(body),
		usesNetwork: /\bfetch\s*\(/.test(body),
	};
}

const STEP_CALL = /\bstep\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const PARALLEL_CALLER = /\bPromise\s*\.\s*(all|allSettled|race|any)\s*$/;

function workflowSteps(
	source: string,
	sourcePath: string,
): { steps: SkillAnatomyStep[]; foundDynamic: boolean } {
	const masked = maskSource(source);
	const blocks = scopeBlocks(masked);
	const steps: SkillAnatomyStep[] = [];
	// Parallel detection: an open-paren stack; a `(` whose caller is
	// Promise.all/race/allSettled/any marks everything inside it.
	const parenStack: boolean[] = [];
	let foundDynamic = false;
	for (const match of masked.matchAll(STEP_CALL)) {
		const method = match[1]!;
		const open = match.index + match[0].length - 1;
		const close = matchParen(masked, open);
		if (close < 0) continue;
		// Rebuild the enclosing-paren state at this call-site cheaply.
		parenStack.length = 0;
		for (let i = 0; i < open; i++) {
			const c = masked[i];
			if (c === "(")
				parenStack.push(
					PARALLEL_CALLER.test(masked.slice(Math.max(0, i - 30), i)),
				);
			else if (c === ")") parenStack.pop();
		}
		const args = splitArgs(masked, open, close).map((span) => ({
			raw: source.slice(span.start, span.end),
			masked: masked.slice(span.start, span.end),
		}));
		if (args.length === 0) continue;
		const nameInfo = classifyName(args[0]!.raw);
		foundDynamic ||= nameInfo.dynamic;
		const scope = enclosing(blocks, match.index);
		// Positional reading of the documented signatures:
		//   step.do(name, [config], callback[, { rollback… }])
		//   step.sleep(name, duration) · step.sleepUntil(name, timestamp)
		//   step.waitForEvent(name, { type, timeout })
		let config: string | null = null;
		let hasRollback = false;
		let body = "";
		if (method === "do") {
			const rest = args.slice(1);
			const firstIsConfig =
				rest.length > 0 && rest[0]!.masked.trim().startsWith("{");
			config = firstIsConfig ? rest[0]!.raw : null;
			const callback = firstIsConfig ? rest[1] : rest[0];
			const rollback = firstIsConfig ? rest[2] : rest[1];
			hasRollback = Boolean(rollback && /\brollback\b/.test(rollback.raw));
			body = args.map((arg) => arg.raw).join("\n");
		} else {
			body = args
				.slice(1)
				.map((arg) => arg.raw)
				.join("\n");
		}
		steps.push({
			id: `s${steps.length}`,
			label: nameInfo.label,
			name: nameInfo.name,
			kind: stepKind(method),
			sourcePath,
			line: lineOf(source, match.index),
			dynamicName: nameInfo.dynamic,
			repeated: scope.loop,
			conditional: scope.branch,
			parallel: parenStack.some(Boolean),
			hasRollback,
			timeout: config
				? stringProp(config, "timeout")
				: method === "waitForEvent"
					? stringProp(args[1]?.raw ?? "", "timeout")
					: null,
			retryLimit: config ? retryLimit(config) : null,
			eventType:
				method === "waitForEvent"
					? stringProp(args[1]?.raw ?? "", "type")
					: null,
			sleepDuration:
				method === "sleep" && args[1]
					? (/^(['"])(.*?)\1$/s.exec(args[1].raw.trim())?.[2] ??
						args[1].raw.trim().slice(0, 40))
					: null,
			sensitiveOutput: config
				? /sensitive\s*:\s*['"]output['"]/.test(config)
				: false,
			...innerCalls(body),
			detail: null,
		});
	}
	return { steps, foundDynamic };
}

/* ------------------------------------------------------------------ */
/* Instruction outline                                                 */
/* ------------------------------------------------------------------ */

const MAX_OUTLINE_STEPS = 12;

function cleanInline(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.trim();
}

function instructionSteps(content: string): SkillAnatomyStep[] {
	const ordered = [...content.matchAll(/^[ \t]{0,3}\d{1,2}[.)]\s+(.+)$/gm)].map(
		(match) => ({ text: match[1]!, index: match.index! }),
	);
	const headings =
		ordered.length >= 2
			? []
			: [...content.matchAll(/^[ \t]{0,3}#{2,6}[ \t]+(.+)$/gm)].map(
					(match) => ({ text: match[1]!, index: match.index! }),
				);
	const outline = (ordered.length >= 2 ? ordered : headings).slice(
		0,
		MAX_OUTLINE_STEPS,
	);
	return outline.map((item, index) => ({
		id: `s${index}`,
		label: cleanInline(item.text).slice(0, 90) || `Step ${index + 1}`,
		name: null,
		kind: "instruction" as const,
		sourcePath: SKILL_DOC_PATH,
		line: lineOf(content, item.index),
		dynamicName: false,
		repeated: false,
		conditional: false,
		parallel: false,
		hasRollback: false,
		timeout: null,
		retryLimit: null,
		eventType: null,
		sleepDuration: null,
		sensitiveOutput: false,
		toolCalls: [],
		usesModel: false,
		usesNetwork: false,
		detail: cleanInline(item.text),
	}));
}

function schemaInputs(
	inputSchema: SkillEntry["inputSchema"],
): SkillAnatomyInput[] {
	if (!inputSchema || typeof inputSchema !== "object") return [];
	const properties = inputSchema["properties"];
	if (
		!properties ||
		typeof properties !== "object" ||
		Array.isArray(properties)
	)
		return [];
	const required = Array.isArray(inputSchema["required"])
		? new Set(
				(inputSchema["required"] as unknown[]).filter(
					(value): value is string => typeof value === "string",
				),
			)
		: new Set<string>();
	return Object.entries(properties as Record<string, unknown>).map(
		([name, value]) => {
			const schema =
				value && typeof value === "object" && !Array.isArray(value)
					? (value as Record<string, unknown>)
					: {};
			return {
				name,
				required: required.has(name),
				type:
					typeof schema["type"] === "string"
						? (schema["type"] as string)
						: null,
				description:
					typeof schema["description"] === "string"
						? (schema["description"] as string)
						: null,
			};
		},
	);
}

/* ------------------------------------------------------------------ */
/* Public derivation                                                   */
/* ------------------------------------------------------------------ */

export function deriveSkillAnatomy(
	skill: Pick<SkillEntry, "content" | "files" | "inputSchema">,
): SkillAnatomy {
	const inputs = schemaInputs(skill.inputSchema);
	const source = skill.files?.[WORKFLOW_SOURCE_PATH];
	if (typeof source === "string" && source.trim().length > 0) {
		const { steps, foundDynamic } = workflowSteps(source, WORKFLOW_SOURCE_PATH);
		const notes: string[] = [
			"Read from the saved source — steps run in the order the code reaches them, which is not always top to bottom.",
		];
		if (steps.length === 0)
			notes.push(
				"No step calls were found in the saved source. The run still decides its own shape — recorded runs show what it actually did.",
			);
		if (foundDynamic)
			notes.push(
				"Steps marked … are named when the run executes; the same line of code can record many step names.",
			);
		if (steps.some((step) => step.repeated))
			notes.push("Steps inside a loop can run once per iteration.");
		if (steps.some((step) => step.conditional))
			notes.push("Steps inside a branch only run when that branch is taken.");
		if (steps.some((step) => step.parallel))
			notes.push("Steps grouped under Promise.all can run at the same time.");
		notes.push(
			"A step declared inside a helper runs each time that helper is called.",
		);
		return { mode: "workflow", inputs, steps, notes };
	}
	const steps = instructionSteps(skill.content ?? "");
	const notes: string[] = [
		"This skill has no executable workflow — an assistant reads the instructions and follows them.",
	];
	if (steps.length === 0)
		notes.push(
			"The instructions declare no numbered steps or sections; the assistant decides its own sequence.",
		);
	return { mode: "instructions", inputs, steps, notes };
}

/* ------------------------------------------------------------------ */
/* Recorded-run matching                                               */
/* ------------------------------------------------------------------ */

export type RecordedStepEvidence = {
	/** Step records in the sampled run with this exact name. */
	records: number;
	outcome: "success" | "failure" | "pending" | "mixed";
	durationMs: number | null;
};

/**
 * Exact-name evidence from one run's recorded steps. Dynamic declared steps
 * can never join this map — matching is honest by construction.
 */
export function recordedStepsByName(
	steps: readonly Pick<SkillWorkflowStep, "name" | "outcome" | "durationMs">[],
): Map<string, RecordedStepEvidence> {
	const map = new Map<
		string,
		{ records: number; outcomes: Set<string>; durationMs: number }
	>();
	for (const step of steps) {
		const entry = map.get(step.name) ?? {
			records: 0,
			outcomes: new Set<string>(),
			durationMs: 0,
		};
		entry.records += 1;
		entry.outcomes.add(step.outcome);
		entry.durationMs += step.durationMs ?? 0;
		map.set(step.name, entry);
	}
	return new Map(
		[...map].map(([name, entry]) => [
			name,
			{
				records: entry.records,
				outcome:
					entry.outcomes.size > 1
						? ("mixed" as const)
						: (entry.outcomes.values().next().value as
								| "success"
								| "failure"
								| "pending"),
				durationMs: entry.durationMs > 0 ? entry.durationMs : null,
			},
		]),
	);
}
