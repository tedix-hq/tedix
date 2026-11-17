import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isObject, type JsonObject } from "./hooks/hook-io";
import { outboxDir, type SessionEvent } from "./hooks/request-ledger";
import { humanText } from "./learn-import";

export const captureCheckUsage =
	() => `tedix capture check [days] [--limit <chats>] [--json]

Compare recent local Claude Code, Codex, OpenCode and Devin chats with this
organization's stored session events. This command is read-only: it does not
enable capture, run hooks, retry the outbox or inspect any other provider.`;

type Harness = "claude-code" | "codex" | "opencode" | "devin";
type CaptureStatus = "captured" | "pending" | "skipped" | "missing";

interface Counts {
	prompts: number;
	turns: number;
}

export interface LocalChat {
	harness: Harness;
	sessionKey: string;
	updatedAt: string;
	transcript: Counts;
	skipReason?: string;
}

export interface StoredEvent {
	harness: string;
	sessionKey: string;
	kind: "prompt" | "turn";
}

export interface CaptureCheckRow extends LocalChat {
	status: CaptureStatus;
	reason?: string;
	stored: Counts;
	pending: Counts;
}

export interface CaptureCheckReport {
	since: string;
	through: string;
	chats: CaptureCheckRow[];
}

function text(
	content: unknown,
	partType: "text" | "input_text" | "output_text",
) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part) =>
				isObject(part) &&
				part.type === partType &&
				typeof part.text === "string",
		)
		.map((part) => String(part.text))
		.join("\n");
}

function countConversation(messages: Array<"user" | "assistant">): Counts {
	let prompts = 0;
	let turns = 0;
	let active = false;
	let answered = false;
	for (const role of messages) {
		if (role === "user") {
			if (active && answered) turns++;
			prompts++;
			active = true;
			answered = false;
		} else if (active) answered = true;
	}
	if (active && answered) turns++;
	return { prompts, turns };
}

function parseJsonLines(path: string): JsonObject[] {
	try {
		return readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line) => {
				try {
					const value: unknown = JSON.parse(line);
					return isObject(value) ? [value] : [];
				} catch {
					return [];
				}
			});
	} catch {
		return [];
	}
}

export function parseClaudeChat(rows: JsonObject[]): LocalChat | undefined {
	let sessionKey = "";
	let updatedAt = "";
	let skipReason: string | undefined;
	const messages: Array<"user" | "assistant"> = [];
	for (const row of rows) {
		if (!sessionKey && typeof row.sessionId === "string")
			sessionKey = row.sessionId;
		if (typeof row.timestamp === "string") updatedAt = row.timestamp;
		if (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk"))
			skipReason = "Agent SDK sessions are unattended";
		if (row.isSidechain) continue;
		const message = isObject(row.message) ? row.message : undefined;
		if (row.type === "assistant" && text(message?.content, "text").trim())
			messages.push("assistant");
		if (
			row.type === "user" &&
			!row.isMeta &&
			!row.isCompactSummary &&
			!row.toolUseResult &&
			!(
				Array.isArray(message?.content) &&
				message.content.some(
					(part) => isObject(part) && part.type === "tool_result",
				)
			) &&
			humanText(text(message?.content, "text")) !== null
		)
			messages.push("user");
	}
	if (!sessionKey) return;
	return {
		harness: "claude-code",
		sessionKey: sessionKey.toLowerCase(),
		updatedAt: updatedAt || new Date(0).toISOString(),
		transcript: countConversation(messages),
		...(skipReason ? { skipReason } : {}),
	};
}

export function parseCodexChat(rows: JsonObject[]): LocalChat | undefined {
	const metaRow = rows.find((row) => row.type === "session_meta");
	const meta = isObject(metaRow?.payload) ? metaRow.payload : undefined;
	const sessionKey = String(meta?.session_id ?? meta?.id ?? "");
	if (!sessionKey) return;
	const source = meta?.thread_source ?? meta?.source;
	const skipReason =
		source === "exec"
			? "codex exec sessions are unattended"
			: meta?.originator === "tedix-lane-dispatcher"
				? "dispatcher lanes are unattended"
				: source === "subagent" ||
					  source === "guardian_review" ||
					  isObject(source)
					? "Codex side threads are unattended"
					: undefined;
	const messages: Array<"user" | "assistant"> = [];
	let updatedAt = "";
	for (const row of rows) {
		if (typeof row.timestamp === "string") updatedAt = row.timestamp;
		const payload = isObject(row.payload) ? row.payload : undefined;
		if (row.type !== "response_item" || payload?.type !== "message") continue;
		if (
			payload.role === "user" &&
			humanText(text(payload.content, "input_text")) !== null
		)
			messages.push("user");
		if (
			payload.role === "assistant" &&
			text(payload.content, "output_text").trim()
		)
			messages.push("assistant");
	}
	return {
		harness: "codex",
		sessionKey: sessionKey.toLowerCase(),
		updatedAt: updatedAt || new Date(0).toISOString(),
		transcript: countConversation(messages),
		...(skipReason ? { skipReason } : {}),
	};
}

export function parseOpenCodeChat(value: unknown): LocalChat | undefined {
	if (
		!isObject(value) ||
		!isObject(value.info) ||
		!Array.isArray(value.messages)
	)
		return;
	const sessionKey = String(value.info.id ?? "");
	if (!sessionKey) return;
	const messages: Array<"user" | "assistant"> = [];
	let updated = Number(
		value.info.time && isObject(value.info.time) ? value.info.time.updated : 0,
	);
	for (const candidate of value.messages) {
		if (!isObject(candidate) || !isObject(candidate.info)) continue;
		const parts = Array.isArray(candidate.parts) ? candidate.parts : [];
		const visible = parts.some(
			(part) =>
				isObject(part) &&
				part.type === "text" &&
				part.synthetic !== true &&
				typeof part.text === "string" &&
				part.text.trim(),
		);
		if (!visible) continue;
		if (candidate.info.role === "user") messages.push("user");
		if (candidate.info.role === "assistant") messages.push("assistant");
		if (isObject(candidate.info.time))
			updated = Math.max(
				updated,
				Number(
					candidate.info.time.completed ?? candidate.info.time.created ?? 0,
				),
			);
	}
	return {
		harness: "opencode",
		sessionKey: sessionKey.toLowerCase(),
		updatedAt: new Date(updated || 0).toISOString(),
		transcript: countConversation(messages),
		...(value.info.parentID
			? { skipReason: "OpenCode subagent sessions are unattended" }
			: {}),
	};
}

export function parseDevinChat(value: unknown): LocalChat | undefined {
	if (!isObject(value) || !Array.isArray(value.steps)) return;
	const sessionKey = String(value.session_id ?? "");
	if (!sessionKey) return;
	const messages: Array<"user" | "assistant"> = [];
	let updatedAt = "";
	for (const step of value.steps) {
		if (
			!isObject(step) ||
			typeof step.message !== "string" ||
			!step.message.trim()
		)
			continue;
		if (step.source === "user") messages.push("user");
		if (step.source === "agent") messages.push("assistant");
		if (typeof step.timestamp === "string") updatedAt = step.timestamp;
	}
	return {
		harness: "devin",
		sessionKey: sessionKey.toLowerCase(),
		updatedAt: updatedAt || new Date(0).toISOString(),
		transcript: countConversation(messages),
	};
}

function jsonFiles(directory: string, depth: number, suffix: string): string[] {
	if (!existsSync(directory)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory() && depth > 0)
			files.push(...jsonFiles(path, depth - 1, suffix));
		else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
	}
	return files;
}

function runJson(command: string, args: string[]): unknown {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 10_000,
	});
	if (result.status !== 0 || !result.stdout) return;
	try {
		return JSON.parse(result.stdout);
	} catch {
		return;
	}
}

export function discoverLocalChats(
	env: NodeJS.ProcessEnv,
	since: Date,
	limit: number,
): LocalChat[] {
	const home = env.HOME || homedir();
	const recent = (path: string) => {
		try {
			return statSync(path).mtimeMs >= since.getTime();
		} catch {
			return false;
		}
	};
	const chats: LocalChat[] = [];
	for (const path of jsonFiles(
		join(home, ".claude", "projects"),
		1,
		".jsonl",
	)) {
		if (!recent(path)) continue;
		const chat = parseClaudeChat(parseJsonLines(path));
		if (chat) chats.push(chat);
	}
	for (const path of [
		...jsonFiles(
			join(env.CODEX_HOME || join(home, ".codex"), "sessions"),
			4,
			".jsonl",
		),
		...jsonFiles(
			join(env.CODEX_HOME || join(home, ".codex"), "archived_sessions"),
			0,
			".jsonl",
		),
	]) {
		if (!recent(path)) continue;
		const chat = parseCodexChat(parseJsonLines(path));
		if (chat) chats.push(chat);
	}
	const openCodeRows = runJson("opencode", [
		"session",
		"list",
		"--format",
		"json",
		"--max-count",
		String(limit),
		"--pure",
	]);
	if (Array.isArray(openCodeRows))
		for (const row of openCodeRows) {
			if (!isObject(row) || Number(row.updated ?? 0) < since.getTime())
				continue;
			const value = runJson("opencode", ["export", String(row.id), "--pure"]);
			const chat = parseOpenCodeChat(value);
			if (chat) chats.push(chat);
		}
	const devinRoot = env.XDG_DATA_HOME || join(home, ".local", "share");
	for (const path of jsonFiles(
		join(devinRoot, "devin", "cli", "transcripts"),
		0,
		".json",
	)) {
		if (!recent(path)) continue;
		try {
			const chat = parseDevinChat(JSON.parse(readFileSync(path, "utf8")));
			if (chat) chats.push(chat);
		} catch {
			// Ignore a partial transcript while Devin writes it.
		}
	}
	return chats
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.filter(
			(chat, index, all) =>
				all.findIndex(
					(candidate) =>
						candidate.harness === chat.harness &&
						candidate.sessionKey === chat.sessionKey,
				) === index,
		)
		.filter(
			(chat, index, all) =>
				all
					.slice(0, index)
					.filter((candidate) => candidate.harness === chat.harness).length <
				limit,
		);
}

export function readPendingEvents(
	env: NodeJS.ProcessEnv,
	binding: JsonObject,
): SessionEvent[] {
	const directory = outboxDir(env, binding, false);
	if (!directory) return [];
	return readdirSync(directory)
		.filter((file) => file.endsWith(".json"))
		.flatMap((file) => {
			try {
				const value: unknown = JSON.parse(
					readFileSync(join(directory, file), "utf8"),
				);
				return isObject(value) ? [value as unknown as SessionEvent] : [];
			} catch {
				return [];
			}
		});
}

function counts(
	events: Array<{
		harness: string;
		sessionKey: string;
		kind: "prompt" | "turn";
	}>,
	chat: LocalChat,
): Counts {
	const own = events.filter(
		(event) =>
			event.harness === chat.harness &&
			event.sessionKey.toLowerCase() === chat.sessionKey,
	);
	return {
		prompts: own.filter((event) => event.kind === "prompt").length,
		turns: own.filter((event) => event.kind === "turn").length,
	};
}

function same(a: Counts, b: Counts) {
	return a.prompts === b.prompts && a.turns === b.turns;
}

export function reconcileCapture(
	chats: LocalChat[],
	storedEvents: StoredEvent[],
	pendingEvents: SessionEvent[],
): CaptureCheckRow[] {
	return chats.map((chat) => {
		const stored = counts(storedEvents, chat);
		const pending = counts(pendingEvents, chat);
		const available = {
			prompts: stored.prompts + pending.prompts,
			turns: stored.turns + pending.turns,
		};
		if (chat.skipReason)
			return {
				...chat,
				stored,
				pending,
				status: "skipped",
				reason: chat.skipReason,
			};
		if (same(chat.transcript, stored))
			return { ...chat, stored, pending, status: "captured" };
		if (same(chat.transcript, available))
			return {
				...chat,
				stored,
				pending,
				status: "pending",
				reason: "The remaining events are in the local outbox",
			};
		return {
			...chat,
			stored,
			pending,
			status: "missing",
			reason:
				"Transcript counts do not match stored events or the local outbox",
		};
	});
}

export function renderCaptureCheck(report: CaptureCheckReport, json: boolean) {
	if (json) return JSON.stringify(report, null, 2);
	const lines = [
		`Capture check ${report.since.slice(0, 10)} through ${report.through.slice(0, 10)}`,
	];
	if (!report.chats.length)
		return `${lines[0]}\nNo recent local Claude Code, Codex, OpenCode or Devin chats found.`;
	for (const chat of report.chats) {
		lines.push(
			`${chat.status.padEnd(8)} ${chat.harness.padEnd(11)} ${chat.sessionKey} transcript ${chat.transcript.prompts} prompts/${chat.transcript.turns} turns; stored ${chat.stored.prompts}/${chat.stored.turns}; pending ${chat.pending.prompts}/${chat.pending.turns}${chat.reason ? `; ${chat.reason}` : ""}`,
		);
	}
	return lines.join("\n");
}
