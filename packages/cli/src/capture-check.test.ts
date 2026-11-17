import { describe, expect, test } from "bun:test";
import {
	parseClaudeChat,
	parseCodexChat,
	parseDevinChat,
	parseOpenCodeChat,
	reconcileCapture,
} from "./capture-check";

describe("capture check", () => {
	const updatedAt = "2026-11-17T06:00:00.000Z";
	const chats = [
		parseClaudeChat([
			{ sessionId: "claude-1", timestamp: updatedAt },
			{ type: "user", message: { content: "first" }, timestamp: updatedAt },
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "one" }] },
			},
			{ type: "user", message: { content: "second" }, timestamp: updatedAt },
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "two" }] },
			},
		]),
		parseCodexChat([
			{ type: "session_meta", payload: { id: "codex-1", source: "user" } },
			{
				type: "response_item",
				timestamp: updatedAt,
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "fix it" }],
				},
			},
			{
				type: "response_item",
				timestamp: updatedAt,
				payload: {
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: "fixed" }],
				},
			},
		]),
		parseOpenCodeChat({
			info: { id: "ses_open", time: { updated: Date.parse(updatedAt) } },
			messages: [
				{ info: { role: "user" }, parts: [{ type: "text", text: "check" }] },
				{
					info: { role: "assistant" },
					parts: [{ type: "text", text: "checked" }],
				},
			],
		}),
		parseDevinChat({
			session_id: "quiet-river",
			steps: [
				{ source: "user", message: "review" },
				{ source: "agent", message: "reviewed" },
			],
		}),
	].filter((chat) => chat !== undefined);

	test("counts one real transcript shape for every supported host", () => {
		expect(chats.map((chat) => [chat.harness, chat.transcript])).toEqual([
			["claude-code", { prompts: 2, turns: 2 }],
			["codex", { prompts: 1, turns: 1 }],
			["opencode", { prompts: 1, turns: 1 }],
			["devin", { prompts: 1, turns: 1 }],
		]);
	});

	test("reports captured, pending, skipped and missing per chat", () => {
		const skipped = parseCodexChat([
			{ type: "session_meta", payload: { id: "exec-1", source: "exec" } },
			{
				type: "response_item",
				timestamp: updatedAt,
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "run" }],
				},
			},
		]);
		const rows = reconcileCapture(
			[...chats, skipped!],
			[
				{ harness: "claude-code", sessionKey: "claude-1", kind: "prompt" },
				{ harness: "claude-code", sessionKey: "claude-1", kind: "prompt" },
				{ harness: "claude-code", sessionKey: "claude-1", kind: "turn" },
				{ harness: "claude-code", sessionKey: "claude-1", kind: "turn" },
				{ harness: "codex", sessionKey: "codex-1", kind: "prompt" },
				{ harness: "opencode", sessionKey: "ses_open", kind: "prompt" },
			],
			[
				{
					harness: "codex",
					sessionKey: "codex-1",
					kind: "turn",
					sourceAt: updatedAt,
					text: "fixed",
				},
			] as never[],
		);
		expect(rows.map((row) => row.status)).toEqual([
			"captured",
			"pending",
			"missing",
			"missing",
			"skipped",
		]);
		expect(rows.at(-1)?.reason).toBe("codex exec sessions are unattended");
	});
});
