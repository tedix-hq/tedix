/**
 * Session event upload for the request ledger, for Claude Code and Codex: no
 * request the person sends, and nothing the agent promises, gets lost.
 *
 * The hooks stay thin. `capture-reply` (UserPromptSubmit) uploads the message
 * the person typed; `capture-stop` (Stop) uploads the agent's full turn
 * text with a digest of the turn's activity read from the host transcript:
 * tool failures, subagents and other agents it started, and their reports.
 * Both go to `work.record_agent_session_events`, which stores them and
 * returns; the observer and reflector run on Tedix in the background and
 * write the private ledger that `prompt-context` reads back. The hook never
 * waits on any analysis. An event is written to a local outbox first and
 * removed once uploaded, so a failed upload is retried by the next hook.
 * The event shape follows claude-mem's async capture hooks (Apache-2.0,
 * github.com/thedotmack/claude-mem); no code is copied.
 *
 * Both run beside decision capture under its opt-in (`tedix setup agents
 * context enable-decision-capture`) and binding, and skip unattended runs.
 * Text is scrubbed with the `tedix learn` and decision-capture redaction
 * before it is written or sent. Failures are silent.
 */
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isScheduledLedgerPrompt } from "@tedix/context-core/request-ledger";
import { humanText, scrub } from "../learn-import";
import { asciiJson, harnessOf } from "./agent-status";
import { bindingFor, redact, repositoryName } from "./decision-capture";
import { referencedCommitEvidence } from "./referenced-commits";
import {
	AGENT_IDENTITY_ENV,
	CAPTURE_EVENT_LIMIT,
	type HookDeps,
	type JsonObject,
	hostEvent,
	isObject,
	isoSeconds,
	PROFILE,
	unattendedRun,
} from "./hook-io";

const TEXT_LIMIT = 8000;
const ACTIVITY_LIMIT = 4000;
const LINE_LIMIT = 240;
/** Events one upload carries; the server accepts up to 20. */
const UPLOAD_BATCH = 20;
/** Outbox entries kept per profile; the oldest go first beyond this. */
const OUTBOX_LIMIT = 500;
const UPLOAD_TIMEOUT_MS = 20_000;

export type LedgerMode = "prompt" | "turn";

export interface SessionEvent {
	kind: LedgerMode;
	harness: string;
	sessionKey: string;
	sourceAt: string;
	text: string;
	activity?: string;
	repository?: string;
}

function bounded(text: string, limit: number, keep: "head" | "tail"): string {
	const [value] = redact(scrub(text), limit, keep);
	return value;
}

function line(text: string): string {
	return bounded(text.replace(/\s+/g, " ").trim(), LINE_LIMIT, "head");
}

/** The redacted text a hook would send, or undefined when it sends nothing. */
export function ledgerText(
	mode: LedgerMode,
	event: JsonObject,
): string | undefined {
	if (mode === "prompt") {
		if (
			typeof event.prompt !== "string" ||
			isScheduledLedgerPrompt(event.prompt)
		)
			return undefined;
		const text = humanText(event.prompt);
		return text ? bounded(text, TEXT_LIMIT, "head") || undefined : undefined;
	}
	const message = event.last_assistant_message;
	if (
		typeof message !== "string" ||
		!message.trim() ||
		/^\s*<heartbeat/.test(message)
	)
		return undefined;
	return bounded(message, message.length, "tail") || undefined;
}

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			isObject(block) && typeof block.text === "string" ? block.text : "",
		)
		.join("\n");
}

/** Keep asks below a summary's opening paragraph visible to the reflector. */
export function assistantActivity(text: string): string[] {
	if (/^\s*<heartbeat/.test(text)) return [];
	return text
		.split("\n")
		.filter((part) => part.trim())
		.map((part) => `Agent said: ${line(part)}`);
}

/** Activity lines of one Claude Code transcript entry. */
function claudeActivity(
	entry: JsonObject,
	tools: Map<string, string>,
	failed: Set<string>,
): string[] {
	const content = entry.message?.content;
	if (!Array.isArray(content)) return [];
	const lines: string[] = [];
	for (const block of content) {
		if (!isObject(block)) continue;
		if (
			entry.type === "assistant" &&
			block.type === "text" &&
			typeof block.text === "string" &&
			!/^\s*<heartbeat/.test(block.text)
		)
			lines.push(...assistantActivity(block.text));
		if (block.type === "tool_use" && typeof block.id === "string") {
			const name = String(block.name ?? "tool");
			tools.set(block.id, name);
			const input = isObject(block.input) ? block.input : {};
			if (name === "Agent" || name === "Task")
				lines.push(
					`Started ${input.run_in_background ? "background " : ""}agent: ${line(String(input.description ?? input.prompt ?? ""))}`,
				);
		}
		if (block.type === "tool_result") {
			const name = tools.get(String(block.tool_use_id)) ?? "tool";
			const text = blockText(block.content);
			if (block.is_error === true) {
				failed.add(name);
				lines.push(`Failed ${name}: ${line(text.split("\n")[0] ?? "")}`);
			} else if (failed.delete(name)) {
				lines.push(`Succeeded ${name} after failure: ${line(text)}`);
			} else if (name === "Agent" || name === "Task")
				lines.push(`Agent reported: ${line(text)}`);
		}
	}
	return lines;
}

/** Activity lines of one Codex rollout entry. */
function codexActivity(
	entry: JsonObject,
	failed: Set<string>,
	tools: Map<string, string>,
): string[] {
	const payload = isObject(entry.payload) ? entry.payload : {};
	if (
		(payload.type === "function_call" || payload.type === "custom_tool_call") &&
		typeof payload.call_id === "string"
	) {
		let detail = "";
		try {
			const args = JSON.parse(String(payload.arguments ?? "{}"));
			detail =
				typeof args.cmd === "string"
					? ` (${line(args.cmd).slice(0, 120)})`
					: "";
		} catch {
			/* Some tools take raw source rather than JSON. */
		}
		tools.set(payload.call_id, `${String(payload.name ?? "command")}${detail}`);
		return [];
	}
	if (
		entry.type === "response_item" &&
		payload.type === "message" &&
		payload.role === "assistant" &&
		(payload.channel === undefined ||
			payload.channel === "commentary" ||
			payload.channel === "final")
	) {
		const content = Array.isArray(payload.content) ? payload.content : [];
		return content.flatMap((block: unknown) =>
			isObject(block) &&
			typeof block.text === "string" &&
			!/^\s*<heartbeat/.test(block.text)
				? assistantActivity(block.text)
				: [],
		);
	}
	if (
		payload.type !== "function_call_output" &&
		payload.type !== "custom_tool_call_output"
	)
		return [];
	const rawOutput = Array.isArray(payload.output)
		? blockText(payload.output)
		: String(payload.output ?? "");
	const output = rawOutput
		.split("\n")
		.map((text) => {
			try {
				const receipt = JSON.parse(text);
				if (
					typeof receipt.output === "string" &&
					typeof receipt.exit_code === "number"
				)
					return `Exit code: ${receipt.exit_code}\n${receipt.output}`;
			} catch {
				/* Plain text is already the tool result. */
			}
			return text;
		})
		.join("\n");
	const name = tools.get(String(payload.call_id)) ?? "command";
	const codes = [
		...output.matchAll(
			/"exit_code"\s*:\s*(-?\d+)|(?:Exit code:|Process exited with code)\s*(-?\d+)/g,
		),
	].map((match) => Number(match[1] ?? match[2]));
	const exit = codes.find((code) => code !== 0) ?? 0;
	const toolError =
		/"isError"\s*:\s*true|MCP tool error:|Error executing tool|^\s*\{"error"\s*:/i.test(
			output,
		);
	if (exit !== 0 || toolError) {
		failed.add("command");
		const detail =
			output
				.split("\n")
				.find((text) =>
					/\b(error|denied|forbidden|bad_request|failed|exception|traceback)\b/i.test(
						text,
					),
				) ?? output;
		return [`Failed ${name}${exit ? ` (exit ${exit})` : ""}: ${line(detail)}`];
	}
	return codes.length && failed.delete("command")
		? [`Succeeded ${name} after failure: ${line(output)}`]
		: [];
}

function isHumanTurn(entry: JsonObject): boolean {
	if (entry.type === "user" && !entry.isMeta) {
		const content = entry.message?.content;
		if (
			Array.isArray(content) &&
			content.some((block) => isObject(block) && block.type === "tool_result")
		)
			return false;
		return humanText(blockText(content)) !== null;
	}
	const payload = isObject(entry.payload) ? entry.payload : {};
	return (
		entry.type === "event_msg" &&
		payload.type === "user_message" &&
		typeof payload.message === "string" &&
		humanText(payload.message) !== null
	);
}

/**
 * Full redacted assistant text, delegated reports and tool/lane activity since
 * the person's last message. Empty when the transcript is unreadable.
 */
export function readTurnTranscript(transcript: unknown): {
	text: string;
	activity: string;
} {
	const empty = { text: "", activity: "" };
	if (
		typeof transcript !== "string" ||
		!isAbsolute(transcript) ||
		!transcript.endsWith(".jsonl")
	)
		return empty;
	let text: string;
	try {
		text = readFileSync(transcript, "utf8");
	} catch {
		return empty;
	}
	const entries: JsonObject[] = [];
	for (const raw of text.split("\n").reverse()) {
		try {
			const value: unknown = JSON.parse(raw);
			if (!isObject(value) || value.isSidechain) continue;
			if (isHumanTurn(value)) break;
			entries.push(value);
		} catch {
			// A torn write at the end of a transcript.
		}
	}
	entries.reverse();
	const tools = new Map<string, string>();
	const failed = new Set<string>();
	const lines: string[] = [];
	const messages: string[] = [];
	for (const entry of entries) {
		if (entry.isSidechain) continue;
		if (entry.type === "user" && entry.isMeta === true) {
			const report = blockText(entry.message?.content);
			if (report.includes("[Subagent hand-back]"))
				messages.push(`DELEGATED AGENT REPORT (not a user reply):\n${report}`);
		}
		const payload = isObject(entry.payload) ? entry.payload : {};
		const message =
			entry.type === "assistant"
				? blockText(entry.message?.content)
				: entry.type === "response_item" &&
					  payload.type === "message" &&
					  payload.role === "assistant" &&
					  (payload.channel === undefined ||
							payload.channel === "commentary" ||
							payload.channel === "final")
					? blockText(payload.content)
					: "";
		if (message.trim() && !/^\s*<heartbeat/.test(message))
			messages.push(message);
		if (entry.type === "user" || entry.type === "assistant") {
			const notice =
				/<task-notification>[\s\S]*?<summary>([\s\S]*?)<\/summary>/.exec(
					blockText(entry.message?.content),
				);
			if (notice) lines.push(`Background task: ${line(notice[1] ?? "")}`);
			lines.push(...claudeActivity(entry, tools, failed));
		} else lines.push(...codexActivity(entry, failed, tools));
	}
	const fullText = messages.join("\n\n");
	return {
		text: bounded(fullText, fullText.length, "head"),
		activity: bounded(
			lines.filter((item) => !item.startsWith("Agent said:")).join("\n"),
			ACTIVITY_LIMIT,
			"tail",
		),
	};
}

function outboxDir(env: NodeJS.ProcessEnv, key: string): string {
	const path = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"session-events",
		key,
	);
	mkdirSync(path, { recursive: true, mode: 0o700 });
	return path;
}

/** Write one event to the outbox; file names sort by write time. */
export function enqueue(dir: string, event: SessionEvent): void {
	const written = `${Date.now()}`.padStart(15, "0");
	const tick = `${process.hrtime.bigint()}`.padStart(20, "0");
	const name = `${written}-${tick}-${randomUUID()}.json`;
	writeFileSync(join(dir, name), JSON.stringify(event), {
		mode: 0o600,
		flag: "wx",
	});
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort();
	for (const file of files.slice(0, Math.max(0, files.length - OUTBOX_LIMIT)))
		rmSync(join(dir, file), { force: true });
}

/** Upload the oldest outbox events once; uploaded ones are removed. */
export async function flush(
	deps: Pick<HookDeps, "read">,
	command: string[],
	dir: string,
): Promise<number> {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort()
		.slice(0, UPLOAD_BATCH);
	const events: Array<[string, SessionEvent]> = [];
	for (const file of files) {
		try {
			events.push([file, JSON.parse(readFileSync(join(dir, file), "utf8"))]);
		} catch {
			rmSync(join(dir, file), { force: true });
		}
	}
	if (!events.length) return 0;
	await deps.read(
		[...command, "code"],
		UPLOAD_TIMEOUT_MS,
		`async () => await work.record_agent_session_events(${asciiJson({ events: events.map(([, event]) => event) })})`,
	);
	for (const [file] of events) rmSync(join(dir, file), { force: true });
	return events.length;
}

export async function runRequestLedger(
	mode: LedgerMode,
	deps: HookDeps,
): Promise<void> {
	const hostEnv = { ...deps.env };
	try {
		const { event, session } = hostEvent(
			deps.stdin,
			deps.env,
			CAPTURE_EVENT_LIMIT,
			{ requireIdentity: true },
		);
		if (unattendedRun(event, hostEnv)) return;
		if (
			mode === "turn" &&
			typeof event.last_assistant_message === "string" &&
			/^\s*<heartbeat/.test(event.last_assistant_message)
		)
			return;
		const turn =
			mode === "turn" ? readTurnTranscript(event.transcript_path) : null;
		const lastText = ledgerText(mode, event);
		const text = turn?.text
			? `${turn.text}${lastText && !turn.text.includes(lastText) ? `\n\n${lastText}` : ""}`
			: lastText;
		if (!text) return;
		// Child reads inherit this process's environment, as in decision capture.
		for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
		const binding = await bindingFor(deps, session!);
		if (!binding || !PROFILE.test(String(binding.workspace))) return;
		const now = (deps.now ?? (() => new Date()))();
		const sourceAt = isoSeconds(now, true);
		const commitEvidence =
			mode === "turn"
				? referencedCommitEvidence(binding.root, text, sourceAt)
				: "";
		const source = text + commitEvidence;
		const activity = turn?.activity ?? "";
		const dir = outboxDir(
			deps.env,
			`${binding.workspace}--${String(binding.organization ?? "default").replace(/[^A-Za-z0-9_-]/g, "")}`,
		);
		enqueue(dir, {
			kind: mode,
			harness: harnessOf(event, hostEnv),
			sessionKey: session!,
			sourceAt,
			text: bounded(source, source.length, "head"),
			...(activity ? { activity } : {}),
			...(binding.contextSource === "default"
				? {}
				: {
						repository: repositoryName(binding.origin, binding.root).slice(
							0,
							200,
						),
					}),
		});
		await flush(deps, binding.command, dir);
	} catch {
		// Upload is best effort; a queued event goes with the next hook.
	}
}
