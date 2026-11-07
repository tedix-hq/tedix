import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import type { ResolveHomePageToolInput } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	normalizePageToolDescriptors,
	normalizePageToolResult,
} from "@tedix/chat-transport/page-tools";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { readHomePageToolCall } from "./quick-chat-home";

/** Only the tools offered by this tab for this run may execute, including on replay. */
export class WorkspaceChatPageTools {
	private turns = new Map<string, { tools: WebMcpToolDef[]; runId?: string }>();
	private pending = new Map<string, RuntimeStreamEvent>();
	private handled = new Set<string>();
	private results = new Map<string, ResolveHomePageToolInput["result"]>();

	offer(key: string, tools: WebMcpToolDef[]) {
		if (!this.turns.has(key)) this.turns.set(key, { tools });
		return normalizePageToolDescriptors(this.turns.get(key)!.tools);
	}

	bind(
		key: string,
		runId: string,
		resolve: (input: ResolveHomePageToolInput) => Promise<unknown>,
	) {
		const turn = this.turns.get(key);
		if (!turn) return;
		turn.runId = runId;
		for (const event of this.pending.values()) {
			if (event.runId !== runId) continue;
			this.pending.delete(event.id);
			void this.handle(event, resolve);
		}
	}

	async handle(
		event: RuntimeStreamEvent,
		resolve: (input: ResolveHomePageToolInput) => Promise<unknown>,
	) {
		const call = readHomePageToolCall(event);
		if (!call || !event.runId) return;
		const turn = [...this.turns.values()].find(
			(turn) => turn.runId === event.runId,
		);
		if (!turn) {
			// Frames can arrive before enqueue returns its durable run identity.
			if ([...this.turns.values()].some((turn) => !turn.runId))
				this.pending.set(event.id, event);
			return;
		}
		const key = `${event.runId}:${call.callId}`;
		if (this.handled.has(key)) return;
		this.handled.add(key);
		const tool = turn.tools.find((tool) => tool.name === call.name);
		let result = this.results.get(key) ?? {
			ok: false,
			content: "This tool was not offered for this turn.",
		};
		try {
			if (!this.results.has(key) && tool && !call.confirm) {
				const output = await tool.execute(call.args);
				result = normalizePageToolResult({
					ok: !output.isError,
					content: output.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				});
			}
		} catch (error) {
			result = normalizePageToolResult({
				ok: false,
				content:
					error instanceof Error ? error.message : "The app tool failed.",
			});
		}
		this.results.set(key, result);
		try {
			await resolve({ runId: event.runId, callId: call.callId, result });
		} catch {
			// Replayed frames may retry delivery, but must never repeat the app write.
			this.handled.delete(key);
		}
	}
}
