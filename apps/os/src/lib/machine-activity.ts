import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sanitizeUntrustedText } from "@/lib/untrusted-text";

export type MachineActionKind =
	| "read"
	| "search"
	| "commits"
	| "commit"
	| "ci"
	| "ci_log"
	| "runner"
	| "edit"
	| "write"
	| "command"
	| "machines"
	| "other";

export type MachineActionStatus = "running" | "waiting" | "done" | "failed";

/** One thing a tedi did on a machine during a turn, as the chat shows it. */
export type MachineAction = {
	key: string;
	kind: MachineActionKind;
	/** What was read, searched, changed or run: a path, a pattern, a command. */
	target: string;
	machine: string;
	status: MachineActionStatus;
	/** The stored start of the result. Empty when there is none. */
	text: string;
	/** The stored result is only the start of the real one. */
	cut: boolean;
	error: string | null;
	exitCode: number | null;
	/** An edit's replaced and new text, or a written file's content. */
	change: { removed: string; added: string } | null;
	/** Set when the machine's call can be read again for its full result. */
	callId: string | null;
};

export type MachineDiffLine = { sign: " " | "+" | "-"; text: string };

const KINDS: Record<string, MachineActionKind> = {
	read_file: "read",
	search_code: "search",
	list_commits: "commits",
	read_commit: "commit",
	read_ci_runs: "ci",
	read_ci_job_log: "ci_log",
	read_runner_state: "runner",
	edit_file: "edit",
	write_file: "write",
	run_command: "command",
	list_machines: "machines",
};

/** `read_machine_file` and `read_file` name the same action. */
function kindOf(name: string): MachineActionKind | null {
	const plain = name.replace(/_machine(?=_|$)/, "");
	return Object.hasOwn(KINDS, plain) ? (KINDS[plain] ?? null) : null;
}

const isMachineTool = (name: string) => /(^|_)machines?(_|$)/.test(name);

/**
 * A tool's stored arguments or result. The event log keeps a small value as
 * it is and a large one as the first characters of its JSON text, so a field
 * is read from either: whole from the object, or as far as the text goes.
 */
function reader(value: unknown): {
	get: (field: string) => string | number | undefined;
	cut: boolean;
} {
	if (!isRecord(value)) return { get: () => undefined, cut: false };
	if (value.truncated !== true || typeof value.preview !== "string")
		return {
			get: (field) => {
				const found = value[field];
				return typeof found === "string" || typeof found === "number"
					? found
					: undefined;
			},
			cut: false,
		};
	const json = value.preview;
	return {
		cut: true,
		get: (field) => {
			const start = new RegExp(`"${field}":\\s*`).exec(json);
			if (!start) return undefined;
			const rest = json.slice(start.index + start[0].length);
			const number = /^-?\d+(\.\d+)?/.exec(rest);
			if (number) return Number(number[0]);
			const text = /^"((?:[^"\\]|\\.)*)("?)/.exec(rest);
			if (!text) return undefined;
			// A cut may land inside an escape: drop the unfinished one.
			const body = (text[1] ?? "").replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
			try {
				return JSON.parse(`"${body}"`) as string;
			} catch {
				return body;
			}
		},
	};
}

const clean = (value: unknown) =>
	typeof value === "string" ? sanitizeUntrustedText(value) : "";
const oneLine = (value: unknown) => clean(value).replace(/\s+/g, " ").trim();

/** Result text arrives fenced as external text; the fence is not content. */
function unfenced(text: string): string {
	return text
		.replace(/^<<<external_[A-Za-z0-9_-]+>>>\n?/, "")
		.replace(/\n?<<<end_external_[A-Za-z0-9_-]+>>>\s*$/, "");
}

function targetOf(
	kind: MachineActionKind,
	args: ReturnType<typeof reader>,
): string {
	const text = (field: string) => oneLine(String(args.get(field) ?? ""));
	switch (kind) {
		case "read": {
			const start = args.get("startLine");
			const end = args.get("endLine");
			const range =
				start && end ? `:${start}-${end}` : start ? `:${start}` : "";
			return `${text("path")}${range}`;
		}
		case "search":
			return text("pathPrefix")
				? `${text("pattern")} in ${text("pathPrefix")}`
				: text("pattern");
		case "commit":
			return text("sha").slice(0, 10);
		case "ci":
			return text("sha").slice(0, 10);
		case "ci_log":
			return text("jobId") ? `job ${text("jobId")}` : "";
		case "command":
			return text("command");
		default:
			return text("path");
	}
}

/** A command's result may carry its exit code as a field or as a line. */
function exitCodeOf(
	result: ReturnType<typeof reader>,
	payload: Record<string, unknown>,
	text: string,
): number | null {
	const field = result.get("exitCode") ?? payload.exitCode;
	if (typeof field === "number") return field;
	const line =
		/(?:^|\n)\s*exit(?:ed with)?(?: code)?:? (-?\d+)\s*(?:\n|$)/i.exec(text);
	return line ? Number(line[1]) : null;
}

function callKey(event: {
	id?: string;
	toolCallId?: string;
	payload?: unknown;
}): string {
	if (event.toolCallId) return event.toolCallId;
	if (isRecord(event.payload) && typeof event.payload.toolCallId === "string")
		return event.payload.toolCallId;
	return (event.id ?? "").replace(/\.(started|completed|failed)$/, "");
}

/**
 * The machine actions in a list of runtime events, oldest first, one per tool
 * call. A call's target comes from its start event, its outcome and the start
 * of its result from its end event; either alone still gives a row. Reading a
 * waiting call's result later fills that call's row instead of adding one.
 */
export function machineActionsFromEvents(
	events: readonly {
		id?: string;
		kind: string;
		toolCallId?: string;
		payload?: unknown;
	}[],
): MachineAction[] {
	const actions = new Map<string, MachineAction>();
	const byCallId = new Map<string, MachineAction>();
	/** A later read of a waiting call, by its own key, to the row it fills. */
	const laterReads = new Map<string, MachineAction>();
	for (const event of events) {
		if (!event.kind.startsWith("tool.") || !isRecord(event.payload)) continue;
		const payload = event.payload;
		const name = typeof payload.name === "string" ? payload.name : "";
		if (!isMachineTool(name)) continue;
		const key = callKey(event);
		if (!key) continue;
		const args = reader(payload.arguments);
		const result = reader(payload.resultPreview);
		const laterRead = name === "read_machine_tool_result";
		if (laterRead && event.kind === "tool.started") {
			const waitingFor = byCallId.get(String(args.get("callId") ?? ""));
			if (waitingFor) laterReads.set(key, waitingFor);
			continue;
		}
		let action = actions.get(key) ?? laterReads.get(key);
		if (!action) {
			action = {
				key,
				kind: kindOf(name) ?? "other",
				target: "",
				machine: "",
				status: "running",
				text: "",
				cut: false,
				error: null,
				exitCode: null,
				change: null,
				callId: null,
			};
			actions.set(key, action);
		}
		if (event.kind === "tool.started") {
			action.target = targetOf(action.kind, args);
			action.machine = oneLine(String(args.get("machine") ?? ""));
			if (action.kind === "edit")
				action.change = {
					removed: clean(args.get("oldText")),
					added: clean(args.get("newText")),
				};
			if (action.kind === "write")
				action.change = { removed: "", added: clean(args.get("content")) };
			continue;
		}
		if (event.kind === "tool.failed") {
			action.status = "failed";
			action.error = oneLine(payload.error) || "The tool call failed";
			continue;
		}
		if (event.kind !== "tool.completed") continue;
		const tool = kindOf(String(result.get("tool") ?? ""));
		if (tool && action.kind === "other") action.kind = tool;
		action.machine ||= oneLine(String(result.get("machine") ?? ""));
		const callId = result.get("callId");
		if (typeof callId === "string" && callId) {
			action.callId = callId;
			byCallId.set(callId, action);
		}
		const kind = result.get("kind");
		const status = result.get("status");
		const error = oneLine(
			unfenced(String(result.get("error") ?? result.get("message") ?? "")),
		);
		action.text = unfenced(clean(result.get("result")));
		action.cut = result.cut;
		action.exitCode = exitCodeOf(result, payload, action.text);
		action.error = error || null;
		action.status =
			kind === "machine_tool_pending" ||
			kind === "machine_tool_awaiting_approval"
				? "waiting"
				: kind === "machine_tool_error" ||
					  status === "failed" ||
					  status === "expired" ||
					  payload.ok === false
					? "failed"
					: "done";
	}
	return [...actions.values()];
}

const PHRASES: Record<MachineActionKind, (count: number) => string> = {
	read: (n) => `read ${n} file${n === 1 ? "" : "s"}`,
	search: (n) => `ran ${n} search${n === 1 ? "" : "es"}`,
	commits: (n) => (n === 1 ? "listed commits" : `listed commits ${n} times`),
	commit: (n) => `read ${n} commit${n === 1 ? "" : "s"}`,
	ci: (n) => (n === 1 ? "checked CI" : `checked CI ${n} times`),
	ci_log: (n) => `read ${n} CI log${n === 1 ? "" : "s"}`,
	runner: (n) =>
		n === 1 ? "checked the runners" : `checked the runners ${n} times`,
	edit: (n) => `edited ${n} file${n === 1 ? "" : "s"}`,
	write: (n) => `wrote ${n} file${n === 1 ? "" : "s"}`,
	command: (n) => `ran ${n} command${n === 1 ? "" : "s"}`,
	machines: () => "listed the machines",
	other: (n) => `${n} other action${n === 1 ? "" : "s"}`,
};

/** "Read 4 files, ran 2 commands": what a group of actions did, in order. */
export function summarizeMachineActions(
	actions: readonly MachineAction[],
): string {
	const counts = new Map<MachineActionKind, number>();
	for (const action of actions)
		counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
	const text = [...counts].map(([kind, n]) => PHRASES[kind](n)).join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An edit as removed and added lines. Lines the old and new text share at the
 * start and the end stay as context. A written file is all added lines.
 */
export function machineDiffLines(change: {
	removed: string;
	added: string;
}): MachineDiffLine[] {
	const before = change.removed ? change.removed.split("\n") : [];
	const after = change.added ? change.added.split("\n") : [];
	let head = 0;
	while (
		head < before.length &&
		head < after.length &&
		before[head] === after[head]
	)
		head += 1;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	)
		tail += 1;
	const line = (sign: MachineDiffLine["sign"]) => (text: string) => ({
		sign,
		text,
	});
	return [
		...before.slice(0, head).map(line(" ")),
		...before.slice(head, before.length - tail).map(line("-")),
		...after.slice(head, after.length - tail).map(line("+")),
		...before.slice(before.length - tail).map(line(" ")),
	];
}
