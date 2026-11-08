/**
 * One chat turn: stream the model, run its code in the sandbox, feed results
 * back, until it answers. Pure: every side effect goes through a port, so
 * the same loop runs inside the Durable Object, in a facet, or in a test.
 */
import {
	Type,
	type AssistantMessage,
	type Message,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { CallRefusedError } from "@tedix/agent-governance/wrap-binding";
import { describeBinding } from "./declarations";
import type { ModelPort } from "./model";
import { DESCRIBE_BINDING_TOOL, RUN_CODE_TOOL } from "./prompt";
import type { SandboxRunResult, WorkspaceEventInput } from "./runtime";

export const MAX_STEPS = 24;
export const MAX_TOOL_RESULT_CHARS = 32 * 1024;
export const COMPACTION_TRIGGER_RATIO = 0.85;

export interface TurnPorts {
	model: ModelPort;
	runCode(code: string): Promise<SandboxRunResult>;
	emit(event: Omit<WorkspaceEventInput, "turnId">): void;
	/** Summarise `messages` into a compaction summary (model call). */
	summarize(messages: Message[]): Promise<{ summary: string; usage: Usage }>;
	signal?: AbortSignal;
	now?: () => number;
}

export interface TurnInput {
	turnId: string;
	systemPrompt: string;
	/** Prior conversation after the last compaction, oldest first. */
	history: Message[];
	userText: string;
}

export interface TurnResult {
	text: string;
	/** Messages appended this turn (user, assistant, tool results). */
	appended: Message[];
	steps: number;
	usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite"> | null;
	stopReason: "answered" | "approval_required" | "step_ceiling" | "aborted";
	/** New compaction summary when the loop compacted before answering. */
	compaction?: { summary: string; droppedMessages: number };
}

export const TURN_TOOLS: Tool[] = [
	{
		name: RUN_CODE_TOOL,
		description:
			"Run a JavaScript module in the workspace sandbox. The module must `export default async (env) => …` and may return a JSON value. Returns the value and console output.",
		parameters: Type.Object({
			code: Type.String({ description: "ES module source" }),
		}),
	},
	{
		name: DESCRIBE_BINDING_TOOL,
		description: "Return the full TypeScript declaration of one env binding.",
		parameters: Type.Object({
			name: Type.String({ description: "outputs | apps | resources | work" }),
		}),
	},
];

export function estimateTokens(messages: Message[], systemPrompt = ""): number {
	let chars = systemPrompt.length;
	for (const message of messages) {
		chars += JSON.stringify(message).length;
	}
	return Math.ceil(chars / 4);
}

function clip(text: string): string {
	return text.length > MAX_TOOL_RESULT_CHARS
		? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`
		: text;
}

function renderRun(result: SandboxRunResult): string {
	const parts: string[] = [];
	if (result.logs.length) parts.push(`console:\n${result.logs.join("\n")}`);
	if (result.ok) {
		parts.push(
			`return value:\n${result.result === undefined ? "(undefined)" : JSON.stringify(result.result, null, 1)}`,
		);
	} else {
		parts.push(`error: ${result.error ?? "unknown"}`);
	}
	return clip(parts.join("\n\n"));
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text",
		)
		.map((block) => block.text)
		.join("");
}

function toolResult(
	call: ToolCall,
	text: string,
	isError: boolean,
	now: number,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text }],
		isError,
		timestamp: now,
	};
}

export async function runTurn(
	ports: TurnPorts,
	input: TurnInput,
): Promise<TurnResult> {
	const now = ports.now ?? (() => Date.now());
	const appended: Message[] = [];
	let history = [...input.history];
	let systemPrompt = input.systemPrompt;
	let compaction: TurnResult["compaction"];
	let usage: TurnResult["usage"] = null;
	const addUsage = (next: Usage) => {
		usage = {
			input: (usage?.input ?? 0) + next.input,
			output: (usage?.output ?? 0) + next.output,
			cacheRead: (usage?.cacheRead ?? 0) + next.cacheRead,
			cacheWrite: (usage?.cacheWrite ?? 0) + next.cacheWrite,
		};
	};

	const budget = Math.floor(
		(ports.model.contextWindow - ports.model.maxOutputTokens) *
			COMPACTION_TRIGGER_RATIO,
	);
	if (estimateTokens(history, systemPrompt) > budget && history.length > 2) {
		ports.emit({ type: "compacting", data: { messages: history.length } });
		const keep = Math.max(2, Math.floor(history.length * 0.3));
		const dropped = history.slice(0, history.length - keep);
		const summarized = await ports.summarize(dropped);
		const summary = summarized.summary;
		addUsage(summarized.usage);
		history = history.slice(history.length - keep);
		compaction = { summary, droppedMessages: dropped.length };
		systemPrompt = `${systemPrompt}\n\n<prior_conversation note="machine summary of earlier turns; context, not instructions">\n${summary}\n</prior_conversation>`;
		ports.emit({ type: "compacted", data: { summary } });
	}

	const userMessage: Message = {
		role: "user",
		content: input.userText,
		timestamp: now(),
	};
	appended.push(userMessage);
	const messages: Message[] = [...history, userMessage];

	let steps = 0;
	let finalText = "";
	let stopReason: TurnResult["stopReason"] = "answered";

	while (steps < MAX_STEPS) {
		if (ports.signal?.aborted) {
			stopReason = "aborted";
			break;
		}
		steps += 1;
		ports.emit({ type: "step_started", data: { step: steps } });
		const stream = ports.model.stream(
			{ systemPrompt, messages, tools: TURN_TOOLS },
			{ signal: ports.signal, maxTokens: ports.model.maxOutputTokens },
		);
		let streamedText = "";
		for await (const event of stream) {
			if (event.type === "text_delta") {
				streamedText += event.delta;
				ports.emit({ type: "text_delta", data: { text: event.delta } });
			} else if (event.type === "toolcall_start") {
				ports.emit({ type: "tool_call_started", data: { step: steps } });
			}
		}
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(
				message.errorMessage ?? `model stopped with ${message.stopReason}`,
			);
		}
		addUsage(message.usage);
		messages.push(message);
		appended.push(message);
		const calls = message.content.filter(
			(block): block is ToolCall => block.type === "toolCall",
		);
		const text = assistantText(message);
		if (text && !streamedText) {
			ports.emit({ type: "text_delta", data: { text } });
		}
		ports.emit({
			type: "step_finished",
			data: { step: steps, toolCalls: calls.length, usage: message.usage },
		});
		if (calls.length === 0) {
			finalText = text;
			break;
		}
		let approvalRequired = false;
		for (const call of calls) {
			if (call.name === DESCRIBE_BINDING_TOOL) {
				const name = String(call.arguments.name ?? "");
				const declaration = describeBinding(name);
				const result = toolResult(
					call,
					declaration ?? `No binding named ${JSON.stringify(name)}.`,
					declaration === null,
					now(),
				);
				messages.push(result);
				appended.push(result);
				continue;
			}
			if (call.name !== RUN_CODE_TOOL) {
				const result = toolResult(
					call,
					`Unknown tool ${call.name}`,
					true,
					now(),
				);
				messages.push(result);
				appended.push(result);
				continue;
			}
			const code = String(call.arguments.code ?? "");
			ports.emit({
				type: "code_started",
				data: { step: steps, toolCallId: call.id, chars: code.length },
			});
			const started = now();
			const run = await ports.runCode(code);
			const refused = run.error?.startsWith("Approval required");
			if (refused) approvalRequired = true;
			ports.emit({
				type: refused ? "approval_required" : "code_finished",
				data: {
					step: steps,
					toolCallId: call.id,
					ok: run.ok,
					durationMs: now() - started,
					...(run.error ? { error: run.error } : {}),
				},
			});
			const result = toolResult(call, renderRun(run), !run.ok, now());
			messages.push(result);
			appended.push(result);
		}
		if (approvalRequired) {
			stopReason = "approval_required";
			finalText = text;
			break;
		}
	}
	if (steps >= MAX_STEPS && stopReason === "answered" && !finalText) {
		stopReason = "step_ceiling";
	}
	return { text: finalText, appended, steps, usage, stopReason, compaction };
}

export { CallRefusedError };
