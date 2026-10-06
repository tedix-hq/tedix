/**
 * Tests for the delegation-visibility improvements:
 *
 *   Part A — readChildRunFullResult assembles a char-budgeted transcript
 *   Part B — latestActivityLabelFromEvents widened to cover the real delegate
 *            event stream (message.received / run.started / subagent.started /
 *            artifact.created / message.completed).
 *
 * `latestActivityLabelFromEvents` is internal; tested via the exported
 * `kernelRuntimeTestHooks.latestActivityLabelFromEventsForTest` seam.
 */

import { describe, expect, it } from "vite-plus/test";
import { kernelRuntimeTestHooks } from "./kernel-runtime/policy-normalization";

const { latestActivityLabelFromEventsForTest: label } = kernelRuntimeTestHooks;

type EventRow = Parameters<typeof label>[0][number];

function makeRow(kind: string, payload?: Record<string, unknown>): EventRow {
	return {
		id: `event:${kind}:${Math.random()}`,
		kind,
		payload: payload ?? null,
		// Minimal required fields — the function only reads kind + payload.
		tediId: "cto",
		runId: "run-1",
		organizationId: "org-1",
		conversationId: "conv-1",
		delta: null,
		runtime: null,
		runtimeMetadata: null,
		createdAt: new Date().toISOString(),
	} as unknown as EventRow;
}

describe("latestActivityLabelFromEvents — Part B widening", () => {
	it("tool.started → 'calling <name>'", () => {
		expect(label([makeRow("tool.started", { name: "search_products" })])).toBe(
			"calling search_products",
		);
	});

	it("tool.completed → 'calling <name>'", () => {
		expect(label([makeRow("tool.completed", { name: "list_invoices" })])).toBe(
			"calling list_invoices",
		);
	});

	it("tool.failed → 'calling <name>'", () => {
		expect(label([makeRow("tool.failed", { name: "get_contact" })])).toBe(
			"calling get_contact",
		);
	});

	it("message.delta → 'responding…'", () => {
		expect(label([makeRow("message.delta")])).toBe("responding…");
	});

	it("step.completed with toolNames → 'calling <last tool>'", () => {
		expect(
			label([
				makeRow("step.completed", {
					toolNames: ["firecrawl_search", "get_page"],
				}),
			]),
		).toBe("calling get_page");
	});

	// ─── NEW event kinds (Part B) ─────────────────────────────────────────────

	it("message.received → 'reading the task'", () => {
		expect(label([makeRow("message.received")])).toBe("reading the task");
	});

	it("run.started → 'thinking…'", () => {
		expect(label([makeRow("run.started")])).toBe("thinking…");
	});

	it("subagent.started → 'delegating…'", () => {
		expect(label([makeRow("subagent.started")])).toBe("delegating…");
	});

	it("artifact.created with name → 'writing <name>'", () => {
		expect(
			label([
				makeRow("artifact.created", { artifact: { name: "turn_summary" } }),
			]),
		).toBe("writing turn_summary");
	});

	it("artifact.created with no name → 'writing artifact'", () => {
		expect(label([makeRow("artifact.created")])).toBe("writing artifact");
	});

	it("artifact.created truncates long name to 35 chars", () => {
		const longName = "a".repeat(40);
		expect(
			label([makeRow("artifact.created", { artifact: { name: longName } })]),
		).toBe(`writing ${"a".repeat(35)}…`);
	});

	it("message.completed (latest, before run.completed) → 'wrapping up…'", () => {
		expect(label([makeRow("message.completed")])).toBe("wrapping up…");
	});

	it("rows are DESC-ordered — newest event wins", () => {
		// artifact.created is newer (index 0), message.received is older (index 1)
		expect(
			label([
				makeRow("artifact.created", { artifact: { name: "turn_summary" } }),
				makeRow("message.received"),
			]),
		).toBe("writing turn_summary");
	});

	it("terminal event (run.completed) produces null — no label for post-hoc record", () => {
		// run.completed is not in the list → falls through to null
		expect(label([makeRow("run.completed")])).toBeNull();
	});

	it("empty rows → null", () => {
		expect(label([])).toBeNull();
	});

	it("tool.started without name → falls through to next event", () => {
		// No name in payload → keeps scanning; finds message.received → "reading the task"
		expect(
			label([
				makeRow("tool.started", {}), // no name
				makeRow("message.received"),
			]),
		).toBe("reading the task");
	});
});
