import { expect, it, vi } from "vite-plus/test";
import { webMcpError, webMcpResult } from "@tedix/webmcp-core/model-context";
import {
	buildDecisionDeckWebMcpTools,
	type DecisionDeckController,
} from "./decision-deck-webmcp-tools";

it("reads the current card, remaining count and readiness on every execution", async () => {
	let state: DecisionDeckController = {
		mode: "decide",
		card: {
			id: "first",
			kind: "question",
			label: "First question",
			decision: null,
		},
		readiness: { unchanged: 1, ready: false, delegated: 0, total: 2 },
		remaining: 2,
	};
	const current = vi.fn(() => state);
	const tools = buildDecisionDeckWebMcpTools(current);
	expect(current).not.toHaveBeenCalled();
	expect(tools.map((tool) => tool.name)).toEqual(["get_decision_deck_card"]);
	const read = tools[0]!;
	expect(await read.execute({})).toEqual(webMcpResult({ ...state }));
	state = {
		mode: "decide",
		card: {
			id: "next",
			kind: "approval",
			label: "Next approval",
			decision: null,
		},
		readiness: { unchanged: 2, ready: true, delegated: 1, total: 3 },
		remaining: 1,
	};
	expect(await read.execute({})).toEqual(webMcpResult({ ...state }));
	state = { mode: "decide", card: null, readiness: null, remaining: 0 };
	expect(await read.execute({})).toEqual(webMcpResult({ ...state }));
	state = {
		mode: "practice",
		card: {
			id: "practice",
			kind: "adr",
			label: "Practice card",
			decision: null,
		},
		readiness: { unchanged: 0, ready: false, delegated: 0, total: 1 },
		remaining: 1,
	};
	expect(await read.execute({})).toEqual(webMcpResult({ ...state }));
	expect(current).toHaveBeenCalledTimes(4);
});

it("returns a bounded unavailable result when the visible controller disappears", async () => {
	const current = vi.fn((): DecisionDeckController => {
		throw new Error("private controller details".repeat(1000));
	});
	const [read] = buildDecisionDeckWebMcpTools(current);
	await expect(read!.execute({})).resolves.toEqual(
		webMcpError("The Decision deck is unavailable. Try again in a moment."),
	);
});
