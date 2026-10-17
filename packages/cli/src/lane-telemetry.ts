import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type * as z from "zod";
import type { LaneTelemetryInputSchema } from "@tedix/api-contract/schemas/work-agent-sessions";
import { scrubText } from "@tedix/context-core/trace-safety";

export type LaneObservation = z.output<typeof LaneTelemetryInputSchema>;
export interface ParsedLane {
	sessionKey: string;
	cwd: string;
	source: string;
	telemetry: LaneObservation;
}
const bounded = (value: string) => scrubText(value).slice(0, 24000);
const textContent = (parts: unknown): string =>
	Array.isArray(parts)
		? parts
				.map((part) => (typeof part?.text === "string" ? part.text : ""))
				.join("\n")
		: typeof parts === "string"
			? parts
			: "";

/** Parse observations only: never execute transcript commands or import instructions. */
export async function parseLaneTranscript(
	path: string,
	executor: "codex" | "claude-code",
): Promise<ParsedLane> {
	const telemetry: LaneObservation = {
		executor,
		model: null,
		provider: executor === "codex" ? "openai" : "anthropic",
		reasoningEffort: null,
		brief: "",
		startedAt: "",
		finishedAt: null,
		heartbeatAt: "",
		tools: {},
		usage: null,
		finalMessage: "",
		outcome: null,
		shas: [],
		workItems: [],
		corrections: [],
		source: "import",
	};
	let sessionKey = "",
		cwd = "",
		source = "",
		completedAt: string | null = null;
	const messages = new Map<
		string,
		{
			model: string;
			input: number;
			cached: number;
			output: number;
			reasoning: number;
			cacheWrite: number;
		}
	>();
	const samples: NonNullable<LaneObservation["usageSamples"]> = [];
	const calls = new Set<string>();
	for await (const line of createInterface({
		input: createReadStream(path),
		crlfDelay: Infinity,
	})) {
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		const at = row.timestamp;
		if (typeof at === "string" && Number.isFinite(Date.parse(at))) {
			if (!telemetry.startedAt)
				telemetry.startedAt = new Date(at).toISOString();
			telemetry.heartbeatAt = new Date(at).toISOString();
		}
		const p = row.payload ?? {};
		if (row.type === "session_meta") {
			sessionKey = p.id ?? p.session_id ?? "";
			cwd = p.cwd ?? "";
			source = p.originator ?? p.source ?? "";
			telemetry.provider = p.model_provider ?? telemetry.provider;
		}
		if (row.type === "turn_context") {
			telemetry.model = p.model ?? telemetry.model;
			telemetry.reasoningEffort =
				p.effort ?? p.reasoning_effort ?? telemetry.reasoningEffort;
		}
		if (
			row.type === "event_msg" &&
			p.type === "token_count" &&
			p.info?.total_token_usage
		) {
			const u = p.info.total_token_usage;
			const prior = telemetry.usage;
			telemetry.usage = {
				input: u.input_tokens,
				cached: u.cached_input_tokens ?? 0,
				output: u.output_tokens,
				reasoning: u.reasoning_output_tokens ?? 0,
			};
			const last = p.info.last_token_usage;
			const delta = {
				input: u.input_tokens - (prior?.input ?? 0),
				cached: (u.cached_input_tokens ?? 0) - (prior?.cached ?? 0),
				output: u.output_tokens - (prior?.output ?? 0),
				reasoning: (u.reasoning_output_tokens ?? 0) - (prior?.reasoning ?? 0),
			};
			// A cumulative duplicate is not another request; incomplete deltas stay unpriced.
			if (
				last &&
				telemetry.model &&
				delta.input === last.input_tokens &&
				delta.output === last.output_tokens &&
				(delta.input || delta.output)
			)
				samples.push({ model: telemetry.model, ...delta, cacheWrite: 0 });
		}
		if (row.type === "response_item") {
			if (
				["function_call", "custom_tool_call"].includes(p.type) &&
				typeof p.name === "string" &&
				!calls.has(p.call_id ?? `${row.ordinal}`)
			) {
				calls.add(p.call_id ?? `${row.ordinal}`);
				telemetry.tools[p.name] = (telemetry.tools[p.name] ?? 0) + 1;
			}
			if (p.type === "message" && p.role === "user" && !telemetry.brief) {
				const content = textContent(p.content);
				// Environment and repository instruction envelopes are not the lane brief.
				if (
					!content.startsWith("# AGENTS.md") &&
					!content.startsWith("<environment_context>")
				)
					telemetry.brief = bounded(content);
			}
			if (
				p.type === "message" &&
				p.role === "assistant" &&
				p.phase === "final_answer"
			)
				telemetry.finalMessage = bounded(textContent(p.content));
		}
		if (row.type === "event_msg") {
			if (p.type === "user_message") {
				if (!telemetry.brief) telemetry.brief = bounded(p.message ?? "");
				else if (
					telemetry.corrections.length < 20 &&
					typeof p.message === "string" &&
					bounded(p.message) !== telemetry.brief
				)
					telemetry.corrections.push(bounded(p.message).slice(0, 2000));
			}
			if (p.type === "agent_message")
				telemetry.finalMessage = bounded(p.message ?? "");
			if (p.type === "task_started") {
				completedAt = null;
				telemetry.outcome = null;
			}
			if (p.type === "task_complete") {
				completedAt = telemetry.heartbeatAt;
				telemetry.finalMessage = bounded(
					p.last_agent_message ?? telemetry.finalMessage,
				);
			}
			if (p.type === "turn_aborted") {
				completedAt = telemetry.heartbeatAt;
				telemetry.outcome = "stopped";
			}
		}
		if (executor === "claude-code") {
			sessionKey = row.sessionId ?? sessionKey;
			cwd = row.cwd ?? cwd;
			const msg = row.message;
			if (row.type === "user" && msg?.role === "user") {
				const content = textContent(msg.content);
				if (content && !telemetry.brief) telemetry.brief = bounded(content);
			}
			if (row.type === "assistant" && msg) {
				telemetry.model = msg.model ?? telemetry.model;
				const key = msg.id ?? row.uuid;
				const prior = messages.get(key) ?? {
					input: 0,
					cached: 0,
					output: 0,
					reasoning: 0,
					model: msg.model ?? "",
					cacheWrite: 0,
				};
				const u = msg.usage;
				if (u)
					messages.set(key, {
						model: msg.model ?? prior.model,
						cacheWrite: Math.max(
							prior.cacheWrite,
							u.cache_creation_input_tokens ?? 0,
						),
						input: Math.max(
							prior.input,
							(u.input_tokens ?? 0) +
								(u.cache_read_input_tokens ?? 0) +
								(u.cache_creation_input_tokens ?? 0),
						),
						cached: Math.max(prior.cached, u.cache_read_input_tokens ?? 0),
						output: Math.max(prior.output, u.output_tokens ?? 0),
						reasoning: 0,
					});
				for (const part of msg.content ?? []) {
					if (part.type === "tool_use" && !calls.has(part.id)) {
						calls.add(part.id);
						telemetry.tools[part.name] = (telemetry.tools[part.name] ?? 0) + 1;
					}
				}
			}
			if (row.type === "assistant" && msg?.stop_reason === "end_turn") {
				telemetry.finalMessage = bounded(textContent(msg.content));
				completedAt = telemetry.heartbeatAt;
			} else if (row.type === "user") completedAt = null;
		}
	}
	if (!sessionKey || !telemetry.startedAt)
		throw new Error("Transcript has no session identity or timestamps");
	if (executor === "claude-code" && messages.size)
		telemetry.usage = [...messages.values()].reduce(
			(total, u) => ({
				input: total.input + u.input,
				cached: total.cached + u.cached,
				output: total.output + u.output,
				reasoning: 0,
			}),
			{ input: 0, cached: 0, output: 0, reasoning: 0 },
		);
	if (executor === "claude-code") samples.push(...messages.values());
	if (samples.length && samples.length <= 10000)
		telemetry.usageSamples = samples;
	telemetry.shas = [
		...new Set(
			[
				...telemetry.finalMessage.matchAll(
					/(?:commit|sha|pushed)[: `*]+([a-f0-9]{40})\b/gi,
				),
			].map((m) => m[1]!.toLowerCase()),
		),
	].slice(0, 100);
	telemetry.workItems = [
		...new Set(
			[
				...telemetry.brief.matchAll(/Work(?:-Item)?[: ]+([a-f0-9-]{36})/gi),
				...telemetry.finalMessage.matchAll(
					/Work(?:-Item)?[: ]+([a-f0-9-]{36})/gi,
				),
			].map((m) => m[1]!),
		),
	].slice(0, 100);
	telemetry.finishedAt = completedAt;
	// A recorded turn completion is an executor outcome, not independent verification.
	if (completedAt && !telemetry.outcome) telemetry.outcome = "succeeded";
	return { sessionKey, cwd, source, telemetry };
}
