import { describe, expect, it } from "vite-plus/test";
import {
	buildRunEventStreamPage,
	buildSelectedRunEventStreamPage,
} from "./kernel-runtime/run-reads-streams";

const ev = (
	id: string,
	kind: string,
	extra: Partial<{
		causeEventId: string | null;
		payload: Record<string, unknown> | null;
		sequence: number | null;
	}> = {},
) => ({
	id,
	kind,
	conversationId: "home:main",
	runId: "run-1",
	causeEventId: null,
	sequence: null,
	delta: null,
	payload: null as Record<string, unknown> | null,
	createdAt: `2026-06-17T00:00:0${id}.000Z`,
	...extra,
});

describe("buildRunEventStreamPage", () => {
	it("returns an empty, open stream when there are no events", () => {
		const r = buildRunEventStreamPage([], { runId: "run-1" });
		expect(r.events).toHaveLength(0);
		expect(r.stream).toMatchObject({
			streamId: "home:run-1",
			offset: 0,
			nextOffset: 0,
			closed: false,
		});
	});

	it("slices from an offset and reports the next offset", () => {
		const rows = ["1", "2", "3", "4", "5"].map((n) =>
			ev(n, "message.delta", n === "3" ? { causeEventId: "input" } : {}),
		);
		const r = buildRunEventStreamPage(rows, { runId: "run-1", offset: 2 });
		expect(r.events.map((e) => e.id)).toEqual(["3", "4", "5"]);
		expect(r.events[0]?.causeEventId).toBe("input");
		expect(r.stream.offset).toBe(2);
		expect(r.stream.nextOffset).toBe(5);
		expect(r.stream.closed).toBe(false);
	});

	it("tail returns the latest slice with the correct offset", () => {
		const rows = ["1", "2", "3", "4", "5"].map((n) => ev(n, "message.delta"));
		const r = buildRunEventStreamPage(rows, { runId: "run-1", tail: 2 });
		expect(r.events.map((e) => e.id)).toEqual(["4", "5"]);
		expect(r.stream.offset).toBe(3);
		expect(r.stream.nextOffset).toBe(5);
	});

	it("namespaces the streamId for a delegated child run", () => {
		const rows = ["1", "2"].map((n) => ev(n, "message.delta"));
		const r = buildRunEventStreamPage(rows, {
			runId: "run-1",
			childRunId: "child-9",
		});
		expect(r.stream.streamId).toBe("home:run-1:child:child-9");
		expect(r.events.map((e) => e.id)).toEqual(["1", "2"]);
	});

	it("detects terminal close + lifts the submissionId", () => {
		const rows = [
			ev("1", "submission.admitted", {
				payload: { submissionId: "sub:run-1" },
			}),
			ev("2", "run.started"),
			ev("3", "submission.settled", {
				payload: { submissionId: "sub:run-1", outcome: "settled" },
			}),
			ev("4", "run.completed"),
		];
		const r = buildRunEventStreamPage(rows, { runId: "run-1" });
		expect(r.stream.closed).toBe(true);
		expect(r.stream.submissionId).toBe("sub:run-1");
		expect(r.stream.terminalEventId).toBe("4");
	});

	it("omitting rowStatus preserves kind-only closure (no regression for existing callers)", () => {
		const rows = [ev("1", "run.started"), ev("2", "run.completed")];
		const r = buildRunEventStreamPage(rows, { runId: "run-1" });
		expect(r.stream.closed).toBe(true);
		expect(r.stream.terminalEventId).toBe("2");
	});

	it("does NOT close on a premature run.completed-kind event when the row itself is still non-terminal", () => {
		// Delegation dispatch writes a run.completed-kind event at ACCEPT time
		// (the child was queued, not that it finished) while the row stays
		// queued/running — the row is authoritative and the stale event-kind
		// signal must not flip closed.
		const rows = [ev("1", "run.started"), ev("2", "run.completed")];
		const r = buildRunEventStreamPage(rows, {
			runId: "run-1",
			rowStatus: "queued",
		});
		expect(r.stream.closed).toBe(false);
		expect(r.stream.terminalEventId).toBeUndefined();
	});

	it("closes once the row status agrees the run is actually terminal", () => {
		const rows = [ev("1", "run.started"), ev("2", "run.completed")];
		const r = buildRunEventStreamPage(rows, {
			runId: "run-1",
			rowStatus: "completed",
		});
		expect(r.stream.closed).toBe(true);
		expect(r.stream.terminalEventId).toBe("2");
	});

	it("a submission.settled event still closes the stream even when the row disagrees (settle is exactly-once, never premature)", () => {
		const rows = [
			ev("1", "run.started"),
			ev("2", "run.completed"),
			ev("3", "submission.settled", {
				payload: { submissionId: "sub:run-1" },
			}),
		];
		const r = buildRunEventStreamPage(rows, {
			runId: "run-1",
			rowStatus: "queued",
		});
		expect(r.stream.closed).toBe(true);
		expect(r.stream.terminalEventId).toBe("3");
	});

	it("a child-run stream is never gated by the PARENT's rowStatus — childRunId bypasses the row check entirely", () => {
		const rows = [ev("1", "run.started"), ev("2", "run.completed")];
		const r = buildRunEventStreamPage(rows, {
			runId: "run-1",
			childRunId: "child-9",
			// If this were mistakenly applied to a child stream, a queued PARENT
			// row would wrongly suppress a real child completion.
			rowStatus: "queued",
		});
		expect(r.stream.closed).toBe(true);
		expect(r.stream.terminalEventId).toBe("2");
	});
});

describe("buildSelectedRunEventStreamPage", () => {
	it("keeps a submitted parent open until the exactly-once settlement fence lands", () => {
		const receiptRows = [
			ev("2", "run.completed"),
			ev("1", "submission.admitted", {
				payload: { submissionId: "sub:run-1" },
			}),
		];
		const r = buildSelectedRunEventStreamPage([], receiptRows, {
			runId: "run-1",
			start: 7,
			rowStatus: "completed",
		});
		expect(r.stream).toMatchObject({
			offset: 7,
			nextOffset: 7,
			closed: false,
			submissionId: "sub:run-1",
		});
		expect(r.stream.terminalEventId).toBeUndefined();
	});

	it("does not apply the parent submission fence to a delegated child stream", () => {
		const receiptRows = [
			ev("2", "run.completed"),
			ev("1", "submission.admitted", {
				payload: { submissionId: "child-submission" },
			}),
		];
		const r = buildSelectedRunEventStreamPage([], receiptRows, {
			runId: "run-1",
			childRunId: "child-1",
			start: 2,
			rowStatus: "running",
		});
		expect(r.stream.closed).toBe(true);
		expect(r.stream.terminalEventId).toBe("2");
	});

	it("keeps an offset page bounded while receipt rows carry terminal state", () => {
		const pageRows = [ev("4", "message.delta"), ev("5", "message.delta")];
		const receiptRows = [
			ev("8", "run.completed"),
			ev("7", "submission.settled", {
				payload: { submissionId: "sub:run-1" },
			}),
		];
		const r = buildSelectedRunEventStreamPage(pageRows, receiptRows, {
			runId: "run-1",
			start: 3,
			rowStatus: "completed",
		});
		expect(r.events.map((event) => event.id)).toEqual(["4", "5"]);
		expect(r.stream).toMatchObject({
			offset: 3,
			nextOffset: 5,
			closed: true,
			terminalEventId: "8",
			submissionId: "sub:run-1",
		});
	});

	it("normalizes DESC receipt rows before choosing the latest terminal", () => {
		const receiptRows = [ev("9", "run.failed"), ev("8", "run.completed")];
		const r = buildSelectedRunEventStreamPage([], receiptRows, {
			runId: "run-1",
			start: 9,
			rowStatus: "failed",
		});
		expect(r.stream.terminalEventId).toBe("9");
	});
});
