import { describe, expect, test } from "bun:test";
import {
	observeHomeEvent,
	observeWorkspaceEvent,
	runIdFromDispatch,
	runIdFromSet,
	scoreAnswer,
	tableRows,
} from "./run.mjs";

const fixture = {
	checks: [
		{ label: "count", pattern: "\\b(?:10|ten)\\b" },
		{ label: "priority", pattern: "controlled memory" },
	],
};

describe("workspace chat benchmark", () => {
	test("scores every fixture check case-insensitively", () => {
		expect(
			scoreAnswer(fixture, "There are ten. CONTROLLED MEMORY is tied."),
		).toEqual({ ok: true, missing: [] });
		expect(scoreAnswer(fixture, "There are 10.")).toEqual({
			ok: false,
			missing: ["priority"],
		});
	});

	test("reads Home deltas and final text from normalized payloads", () => {
		const state = {
			answer: "",
			error: "",
			firstTokenMs: null as number | null,
		};
		observeHomeEvent(
			state,
			{ kind: "message.delta", payload: { text: "" } },
			10,
		);
		observeHomeEvent(
			state,
			{ kind: "message.delta", payload: { text: "First" } },
			20,
		);
		observeHomeEvent(
			state,
			{ kind: "message.completed", payload: { content: "Final answer" } },
			30,
		);
		expect(state).toEqual({
			answer: "Final answer",
			error: "",
			firstTokenMs: 20,
		});
	});

	test("binds workspace events to the accepted turn", () => {
		const state = {
			answer: "",
			clientTurnId: "client-turn",
			conversationId: null,
			finished: false,
			firstTokenMs: null as number | null,
			status: "running",
			turnId: null,
		};
		observeWorkspaceEvent(
			state,
			{ type: "assistant.delta", turnId: "other", text: "No" },
			5,
		);
		observeWorkspaceEvent(
			state,
			{
				type: "turn.accepted",
				clientTurnId: "client-turn",
				turnId: "turn",
				conversationId: "conversation",
			},
			10,
		);
		observeWorkspaceEvent(
			state,
			{ type: "assistant.delta", turnId: "turn", text: "Hi" },
			12,
		);
		observeWorkspaceEvent(
			state,
			{ type: "assistant.done", turnId: "turn", text: "Final" },
			20,
		);
		observeWorkspaceEvent(
			state,
			{ type: "turn.finished", turnId: "turn", status: "done" },
			25,
		);
		expect(state).toMatchObject({
			answer: "Final",
			conversationId: "conversation",
			finished: true,
			firstTokenMs: 12,
			status: "done",
			turnId: "turn",
		});
	});

	test("unwraps the Home dispatch receipt", () => {
		expect(
			runIdFromDispatch({ result: { result: { homeRunId: "run" } } }),
		).toBe("run");
		expect(runIdFromSet({ runSet: { runs: [{ id: "run" }] } })).toBe("run");
	});

	test("prints missing timing as n/a", () => {
		expect(
			tableRows([
				{
					id: "one",
					transport: "home",
					firstTokenMs: null,
					finalMs: 1234,
					ok: false,
					missing: ["answer"],
				},
			]),
		).toEqual([
			{
				question: "one",
				transport: "home",
				"first token": "n/a",
				"final answer": "1.23s",
				correct: "FAIL",
				missing: "answer",
			},
		]);
	});
});
