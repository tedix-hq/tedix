import { describe, expect, test } from "bun:test";
import { createAnswerStream } from "./answer-stream";
import type { HomeRunEvent } from "./home-client";

function delta(
	sequence: number,
	content: string,
	streamAttempt?: number,
): HomeRunEvent {
	return {
		offset: String(sequence),
		kind: "message.delta",
		sequence,
		payload: {
			role: "assistant",
			channel: "home",
			content,
			metadata: {
				homeSubject: true,
				source: "kernelRuntime.answerStream",
				...(streamAttempt ? { streamAttempt } : {}),
			},
		},
	};
}

describe("@tedix/cli answer stream", () => {
	test("accumulates batched deltas into the answer so far", () => {
		const stream = createAnswerStream();
		expect(stream.ingest(delta(1, "Hello"))?.text).toBe("Hello");
		expect(stream.ingest(delta(2, ", world"))?.text).toBe("Hello, world");
		expect(stream.snapshot()).toEqual({ text: "Hello, world", settled: false });
	});

	test("orders by the row sequence, not by arrival", () => {
		const stream = createAnswerStream();
		stream.ingest(delta(2, "second "));
		stream.ingest(delta(1, "first "));
		stream.ingest(delta(3, "third"));
		expect(stream.snapshot().text).toBe("first second third");
	});

	test("a re-read of the same page does not duplicate text", () => {
		const stream = createAnswerStream();
		stream.ingest(delta(1, "one "));
		stream.ingest(delta(2, "two"));
		expect(stream.ingest(delta(1, "one "))).toBeNull();
		expect(stream.ingest(delta(2, "two"))).toBeNull();
		expect(stream.snapshot().text).toBe("one two");
	});

	test("a durable re-drive replaces the pre-crash partial", () => {
		const stream = createAnswerStream();
		stream.ingest(delta(1, "partial before the crash"));
		expect(stream.ingest(delta(1, "replayed ", 1))?.text).toBe("replayed ");
		expect(stream.ingest(delta(2, "answer", 1))?.text).toBe("replayed answer");
		// A straggling row from the retired attempt cannot re-enter the text.
		expect(stream.ingest(delta(3, " stale tail"))).toBeNull();
		expect(stream.snapshot().text).toBe("replayed answer");
	});

	test("rows without a sequence keep arrival order", () => {
		const stream = createAnswerStream();
		const noSequence = (content: string): HomeRunEvent => ({
			offset: "0",
			kind: "message.delta",
			payload: content,
		});
		stream.ingest(noSequence("a"));
		stream.ingest(noSequence("b"));
		stream.ingest(noSequence("c"));
		expect(stream.snapshot().text).toBe("abc");
	});

	test("the canonical message wins: later deltas are ignored once settled", () => {
		const stream = createAnswerStream();
		stream.ingest(delta(1, "partial"));
		const settled = stream.ingest({
			offset: "2",
			kind: "message.completed",
			payload: { role: "assistant", content: "the full canonical answer" },
		});
		expect(settled).toEqual({ text: "partial", settled: true });
		// Deltas that sort after the terminal frame must not resurrect the partial.
		expect(stream.ingest(delta(2, " more"))).toBeNull();
		expect(stream.snapshot()).toEqual({ text: "partial", settled: true });
	});

	test("a terminal run frame settles the stream too", () => {
		for (const kind of ["run.completed", "run.failed", "run.canceled"]) {
			const stream = createAnswerStream();
			stream.ingest(delta(1, "partial"));
			expect(stream.ingest({ offset: "2", kind })?.settled).toBe(true);
			expect(stream.ingest(delta(2, " more"))).toBeNull();
		}
	});

	test("settling twice reports a change only once", () => {
		const stream = createAnswerStream();
		expect(
			stream.ingest({ offset: "1", kind: "message.completed" })?.settled,
		).toBe(true);
		expect(stream.ingest({ offset: "2", kind: "run.completed" })).toBeNull();
	});

	test("a reasoning stream projects message.reasoning rows and ignores answer deltas", () => {
		const stream = createAnswerStream({ kind: "message.reasoning" });
		const reasoning = (sequence: number, content: string): HomeRunEvent => ({
			offset: String(sequence + 100),
			kind: "message.reasoning",
			sequence,
			payload: { role: "assistant", content },
		});
		expect(stream.ingest(reasoning(0, "This"))?.text).toBe("This");
		expect(stream.ingest(delta(1, "Tedix is"))).toBeNull();
		expect(stream.ingest(reasoning(1, " is a general question"))?.text).toBe(
			"This is a general question",
		);
		expect(
			stream.ingest({ offset: "9", kind: "message.completed" })?.settled,
		).toBe(true);
		expect(stream.ingest(reasoning(2, " straggler"))).toBeNull();
		expect(stream.snapshot().text).toBe("This is a general question");
	});

	test("unrelated and empty frames are inert", () => {
		const stream = createAnswerStream();
		expect(
			stream.ingest({
				offset: "0",
				kind: "tool.started",
				payload: { name: "search" },
			}),
		).toBeNull();
		expect(stream.ingest({ offset: "1", kind: "message.phase" })).toBeNull();
		expect(stream.ingest(delta(1, ""))).toBeNull();
		expect(stream.snapshot()).toEqual({ text: "", settled: false });
	});
});
