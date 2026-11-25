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
 * removed once uploaded, so a failed upload is retried by the next hook or
 * the next session start. An event the server keeps rejecting is moved to
 * the outbox's `rejected/` folder; `outbox.log` there records every event
 * set aside or trimmed.
 * Events are captured asynchronously so a hook never blocks the session.
 *
 * Both run beside decision capture under its opt-in (`tedix setup agents
 * context enable-decision-capture`) and binding, and skip unattended runs.
 * Text is scrubbed with the `tedix learn` and decision-capture redaction
 * before it is written or sent. Failures are silent.
 */
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isScheduledLedgerPrompt } from "@tedix/context-core/request-ledger";
import { humanText, scrub, typedRemainder } from "../learn-import";
import { asciiJson, harnessOf } from "./agent-status";
import { bindingFor, redact, repositoryName } from "./decision-capture";
import { referencedCommitEvidence } from "./referenced-commits";
import { AGENT_IDENTITY_ENV } from "../shared";
import {
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
/** Most of a prompt kept when only code, tags or a log were found in it. */
const FILTERED_LIMIT = 2000;
export const FILTERED_MARK =
	"[filtered: this message was only code, tags or a pasted log; shortened, it may still hold a request]";
const ACTIVITY_LIMIT = 4000;
const LINE_LIMIT = 240;
/** Events one upload carries; the server accepts up to 20. */
const UPLOAD_BATCH = 20;
/** Outbox entries kept per profile; the oldest go first beyond this. */
const OUTBOX_LIMIT = 500;
const UPLOAD_TIMEOUT_MS = 20_000;
/**
 * Characters of one event's text. The upload schema sets no maximum; the
 * server stores the text in one D1 row of at most 2,000,000 bytes, and a
 * character takes up to three bytes.
 */
const UPLOAD_TEXT_LIMIT = 500_000;
/** Passes in which the server took other events but not this one, before it is set aside. */
const REJECTION_LIMIT = 3;
/** One-by-one uploads tried before a pass with no success stops. */
const OFFLINE_PROBES = 3;
/** Set-aside events kept for inspection. */
const REJECTED_LIMIT = 100;
const LOG_LIMIT = 262_144;

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
		if (text) return bounded(text, TEXT_LIMIT, "head") || undefined;
		const rest = typedRemainder(event.prompt);
		if (!rest) return undefined;
		// An ask sits above or below a paste, so both ends are kept.
		const full = bounded(rest, rest.length, "head");
		const half = FILTERED_LIMIT / 2;
		return `${FILTERED_MARK}\n${
			full.length > FILTERED_LIMIT
				? `${full.slice(0, half)}\n…\n${full.slice(-half)}`
				: full
		}`;
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

/** Redacted event text cut in the middle, keeping the turn's start and its closing asks. */
function uploadText(text: string): string {
	const full = bounded(text, text.length, "head");
	if (full.length <= UPLOAD_TEXT_LIMIT) return full;
	const half = UPLOAD_TEXT_LIMIT / 2 - 2;
	return `${full.slice(0, half)}\n…\n${full.slice(-half)}`;
}

/** The outbox of one profile and organization; undefined when `create` is off and nothing was queued. */
export function outboxDir(
	env: NodeJS.ProcessEnv,
	binding: JsonObject,
	create = true,
): string | undefined {
	const path = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"session-events",
		`${binding.workspace}--${String(binding.organization ?? "default").replace(/[^A-Za-z0-9_-]/g, "")}`,
	);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	return create || existsSync(path) ? path : undefined;
}

/** One line in the outbox's own `outbox.log`: what was trimmed or set aside. */
function outboxLog(dir: string, message: string): void {
	try {
		const path = join(dir, "outbox.log");
		if (existsSync(path) && statSync(path).size > LOG_LIMIT)
			renameSync(path, `${path}.1`);
		appendFileSync(path, `${isoSeconds(new Date(), true)} ${message}\n`, {
			mode: 0o600,
		});
	} catch {
		// Logging is best effort.
	}
}

function queued(dir: string): string[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort();
}

/** Delete the oldest files beyond `limit` and log how many went. */
function trim(dir: string, limit: number, log: string, what: string): void {
	const files = queued(dir);
	const excess = files.slice(0, Math.max(0, files.length - limit));
	for (const file of excess) rmSync(join(dir, file), { force: true });
	if (excess.length)
		outboxLog(log, `trimmed ${excess.length} oldest ${what} beyond ${limit}`);
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
	trim(dir, OUTBOX_LIMIT, dir, "unsent events");
}

/** Move an event out of the upload queue into `rejected/`, with the reason logged. */
function setAside(dir: string, file: string, reason: string): void {
	const aside = join(dir, "rejected");
	mkdirSync(aside, { recursive: true, mode: 0o700 });
	renameSync(join(dir, file), join(aside, file));
	outboxLog(dir, `set aside ${file}: ${reason}`);
	trim(aside, REJECTED_LIMIT, dir, "set-aside events");
}

/**
 * Upload the oldest outbox events once; uploaded ones are removed. When the
 * batch fails and `isolate` is on, events go one by one, so an event the
 * server keeps rejecting is counted and then set aside instead of holding
 * back every newer one.
 */
export async function flush(
	deps: Pick<HookDeps, "read">,
	command: string[],
	dir: string,
	{ timeoutMs = UPLOAD_TIMEOUT_MS, isolate = true } = {},
): Promise<number> {
	const events: Array<[string, SessionEvent]> = [];
	for (const file of queued(dir).slice(0, UPLOAD_BATCH)) {
		try {
			events.push([file, JSON.parse(readFileSync(join(dir, file), "utf8"))]);
		} catch {
			setAside(dir, file, "unreadable");
		}
	}
	if (!events.length) return 0;
	const upload = async (batch: Array<[string, SessionEvent]>) => {
		await deps.read(
			[...command, "code"],
			timeoutMs,
			`async () => await work.record_agent_session_events(${asciiJson({ events: batch.map(([, event]) => event) })})`,
		);
		for (const [file] of batch) rmSync(join(dir, file), { force: true });
	};
	try {
		await upload(events);
		return events.length;
	} catch (error) {
		if (!isolate || events.length === 1) throw error;
	}
	const failed: Array<[string, string]> = [];
	let uploaded = 0;
	for (const event of events) {
		try {
			await upload([event]);
			uploaded++;
		} catch (error) {
			failed.push([event[0], line(String((error as Error)?.message ?? error))]);
			// Nothing gets through: offline or signed out, not a bad event.
			if (!uploaded && failed.length === OFFLINE_PROBES) break;
		}
	}
	// A failure counts against an event only when the server took another one
	// in the same pass.
	if (uploaded)
		for (const [file, reason] of failed) {
			const count = Number(/\.r(\d+)\.json$/.exec(file)?.[1] ?? 0) + 1;
			if (count >= REJECTION_LIMIT)
				setAside(dir, file, `rejected ${count} times: ${reason}`);
			else
				renameSync(
					join(dir, file),
					join(dir, file.replace(/(\.r\d+)?\.json$/, `.r${count}.json`)),
				);
		}
	return uploaded;
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
		const lastText = ledgerText(
			mode,
			mode === "turn" &&
				harnessOf(event, hostEnv) === "opencode" &&
				typeof event.opencode_turn_text === "string"
				? { ...event, last_assistant_message: event.opencode_turn_text }
				: event,
		);
		const text = turn?.text
			? `${turn.text}${lastText && !turn.text.includes(lastText) ? `\n\n${lastText}` : ""}`
			: lastText;
		if (!text) return;
		// Child reads inherit this process's environment, as in decision capture.
		for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
		let dir: string | undefined;
		// Queued once the local opt-in is known, before any live check can fail.
		const binding = await bindingFor(deps, session!, (optedIn) => {
			if (!PROFILE.test(String(optedIn.workspace))) return;
			const now = (deps.now ?? (() => new Date()))();
			const sourceAt = isoSeconds(now, true);
			const commitEvidence =
				mode === "turn"
					? referencedCommitEvidence(optedIn.root, text, sourceAt)
					: "";
			const source = text + commitEvidence;
			const activity = turn?.activity ?? "";
			const outbox = outboxDir(deps.env, optedIn)!;
			enqueue(outbox, {
				kind: mode,
				harness: harnessOf(event, hostEnv),
				sessionKey: session!,
				sourceAt,
				text: uploadText(source),
				...(activity ? { activity } : {}),
				...(optedIn.contextSource === "default"
					? {}
					: {
							repository: repositoryName(optedIn.origin, optedIn.root).slice(
								0,
								200,
							),
						}),
			});
			dir = outbox;
		});
		if (binding && dir) await flush(deps, binding.command, dir);
	} catch {
		// Upload is best effort; a queued event goes with the next hook.
	}
}
