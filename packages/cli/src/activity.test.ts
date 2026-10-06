import { describe, expect, test } from "bun:test";
import {
	type ActivityRowPhase,
	activityRowPhase,
	formatActivityRow,
	formatThinkingRow,
	StatusSpinner,
	spinnerLabel,
	streamTailText,
} from "./activity";
import { unrenderedAnswerText } from "./format";
import type { ColorMode } from "./terminal";
import type { HomeRunSummary } from "./home-client";

const NO_COLOR: ColorMode = { enabled: false };

function fakeStream(): { writes: string[]; stream: NodeJS.WriteStream } {
	const writes: string[] = [];
	const stream = {
		write: (chunk: string) => {
			writes.push(chunk);
			return true;
		},
	} as unknown as NodeJS.WriteStream;
	return { writes, stream };
}

describe("@tedix/cli activity rows", () => {
	test("formatActivityRow leaves streamed answer frames to the answer stream", () => {
		expect(
			formatActivityRow(
				{
					offset: "0",
					kind: "message.delta",
					payload: { role: "assistant", content: "half an answer" },
				},
				NO_COLOR,
			),
		).toBeNull();
	});

	test("formatActivityRow renders a phase row in product language, never the bare kind", () => {
		const row = formatActivityRow(
			{
				offset: "3",
				kind: "message.phase",
				sequence: 2,
				payload: { phase: "preparing_context", at: "2026-09-15T03:13:24.310Z" },
			},
			NO_COLOR,
		);
		expect(row).toBe("  · Preparing context");
		expect(row).not.toContain("message phase");
		expect(
			formatActivityRow(
				{
					offset: "4",
					kind: "message.phase",
					payload: { phase: "generating" },
				},
				NO_COLOR,
			),
		).toBe("  · Writing");
	});

	test("formatActivityRow carries the phase detail and humanizes an unknown phase", () => {
		expect(
			formatActivityRow(
				{
					offset: "5",
					kind: "message.phase",
					payload: { phase: "using_tool", detail: "search_threads" },
				},
				NO_COLOR,
			),
		).toBe("  · Using a tool search_threads");
		expect(
			formatActivityRow(
				{
					offset: "6",
					kind: "message.phase",
					payload: { phase: "reticulating_splines" },
				},
				NO_COLOR,
			),
		).toBe("  · reticulating splines");
		expect(
			formatActivityRow(
				{ offset: "7", kind: "message.phase", payload: {} },
				NO_COLOR,
			),
		).toBeNull();
	});

	test("formatActivityRow leaves rationale chunks to the thinking line", () => {
		expect(
			formatActivityRow(
				{
					offset: "8",
					kind: "message.reasoning",
					sequence: 0,
					payload: { role: "assistant", content: "This" },
				},
				NO_COLOR,
			),
		).toBeNull();
	});

	test("formatThinkingRow is one muted line of the rationale so far", () => {
		expect(
			formatThinkingRow("This is a general\n  Tedix question.", NO_COLOR),
		).toBe("  · thinking This is a general Tedix question.");
		expect(formatThinkingRow("   ", NO_COLOR)).toBeNull();
		expect(formatThinkingRow("\u001b[31mred\u001b[0m text", NO_COLOR)).toBe(
			"  · thinking red text",
		);
	});

	test("formatActivityRow skips the user input and terminal events", () => {
		for (const kind of [
			"message.received",
			"run.completed",
			"message.completed",
		]) {
			expect(formatActivityRow({ offset: "0", kind }, NO_COLOR)).toBeNull();
		}
	});

	test("formatActivityRow surfaces delegation target", () => {
		const row = formatActivityRow(
			{
				offset: "1",
				kind: "run.started",
				payload: { status: "needs_delegation", targetTediLabel: "CTO" },
			},
			NO_COLOR,
		);
		expect(row).toContain("delegating");
		expect(row).toContain("CTO");
	});

	test("formatActivityRow labels tool, submission, and generic kinds", () => {
		expect(
			formatActivityRow(
				{ offset: "2", kind: "tool.call", payload: { name: "search" } },
				NO_COLOR,
			),
		).toContain("search");
		expect(
			formatActivityRow({ offset: "3", kind: "submission.admitted" }, NO_COLOR),
		).toContain("submission admitted");
		expect(
			formatActivityRow({ offset: "4", kind: "plan.proposed" }, NO_COLOR),
		).toContain("plan proposed");
	});

	test("child rows are prefixed with the delegated tedi label", () => {
		const row = formatActivityRow(
			{ offset: "5", kind: "tool.call", payload: { name: "grep" } },
			NO_COLOR,
			{ tediLabel: "CTO" },
		);
		expect(row).toContain("↳ CTO");
		expect(row).toContain("grep");
	});

	test("child run completion is kept inline (unlike the parent)", () => {
		const parent = formatActivityRow(
			{ offset: "6", kind: "run.completed" },
			NO_COLOR,
		);
		const child = formatActivityRow(
			{ offset: "6", kind: "run.completed" },
			NO_COLOR,
			{ tediLabel: "CTO" },
		);
		expect(parent).toBeNull();
		expect(child).toContain("↳ CTO");
	});

	// ── P6: richer tool-call rows ────────────────────────────────────────────

	test("tool.started row is cyan, contains name + args excerpt", () => {
		// Real payload shape from mcp-client-core/src/runtime.ts:666-671:
		//   { name: string, arguments: Record<string, unknown> }
		const row = formatActivityRow(
			{
				offset: "7",
				kind: "tool.started",
				payload: { name: "bash", arguments: { command: "ls /tmp" } },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).toContain("tool");
		expect(row).toContain("bash");
		// Args serialized as compact JSON excerpt
		expect(row).toContain("command");
	});

	test("tool.completed row contains name + result excerpt", () => {
		// Real payload shape from mcp-client-core/src/runtime.ts:680-688:
		//   { name: string, result: <truncated>, latencyMs: number }
		const row = formatActivityRow(
			{
				offset: "8",
				kind: "tool.completed",
				payload: { name: "search", result: { items: 3 }, latencyMs: 240 },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).toContain("✓ tool");
		expect(row).toContain("search");
		expect(row).toContain("items");
	});

	test("tool.failed row contains name + error", () => {
		// Real payload shape from mcp-client-core/src/runtime.ts:693-700:
		//   { name: string, error: string, latencyMs: number }
		const row = formatActivityRow(
			{
				offset: "9",
				kind: "tool.failed",
				payload: {
					name: "http_get",
					error: "Connection refused",
					latencyMs: 50,
				},
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).toContain("tool");
		expect(row).toContain("http_get");
		expect(row).toContain("Connection refused");
	});

	test("tool event with only a name falls back gracefully (no excerpt)", () => {
		// Minimal payload: only the `name` field, no arguments/result/error.
		const row = formatActivityRow(
			{
				offset: "10",
				kind: "tool.started",
				payload: { name: "list_skills" },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).toContain("tool");
		expect(row).toContain("list_skills");
		// No crash — no excerpt is fine
	});

	test("tool.completed using tedi-runtime shape (toolName + data) works", () => {
		// Real payload shape from tedi-runtime/src/do.ts:4986-4989:
		//   { toolName: string, data: <object> }
		const row = formatActivityRow(
			{
				offset: "11",
				kind: "tool.completed",
				payload: { toolName: "record_skill", data: { skillId: "abc-123" } },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).toContain("✓ tool");
		expect(row).toContain("record_skill");
		expect(row).toContain("skillId");
	});

	test("spinnerLabel includes progress, status, route, and target", () => {
		const summary: HomeRunSummary = {
			assistantText: "",
			homeRunId: "r",
			status: "running",
			targetTediLabel: "CTO",
			kernelRoute: { routeKind: "delegate_tedi" },
		};
		const label = spinnerLabel(summary, NO_COLOR);
		expect(label).toContain("running");
		expect(label).toContain("delegate_tedi");
		expect(label).toContain("CTO");

		const withProgress = spinnerLabel(
			{ ...summary, progressLabel: "Thinking" },
			NO_COLOR,
		);
		expect(withProgress).toContain("Thinking");
	});
});

describe("@tedix/cli activity row — ANSI injection + surrogate-safe slicing", () => {
	test("tool.completed with ANSI in result string is sanitized", () => {
		const row = formatActivityRow(
			{
				offset: "20",
				kind: "tool.completed",
				payload: {
					name: "evil_tool",
					result: "\x1b[31mhacked\x1b[0m real content",
				},
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		// Raw ANSI should be stripped
		expect(row).not.toContain("\x1b[31m");
		expect(row).toContain("hacked");
		expect(row).toContain("real content");
	});

	test("tool.failed with ANSI in error string is sanitized", () => {
		const row = formatActivityRow(
			{
				offset: "21",
				kind: "tool.failed",
				payload: {
					name: "evil_tool",
					error: "\x1b]0;evil title\x07harmless error",
				},
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		expect(row).not.toContain("evil title");
		expect(row).toContain("harmless error");
	});

	test("tool.completed with long astral codepoint result slices at codepoint boundary", () => {
		// 🎉 is U+1F389, a 2-UTF-16-unit surrogate pair
		// Create a string of 30 emoji (each 2 code units = 60 chars total, but 30 codepoints)
		// Then append enough more to exceed 80 codepoints total
		const emoji = "🎉".repeat(85);
		const row = formatActivityRow(
			{
				offset: "22",
				kind: "tool.completed",
				payload: { name: "emoji_tool", result: emoji },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		// The result should contain only complete emoji — no bisected surrogates
		// Extract the detail portion (after tool name)
		const detail = row!.split("emoji_tool")[1] ?? "";
		// Every character in the excerpt should be a valid emoji or the … truncation marker
		// Check no lone surrogates (which would appear as replacement chars in JS strings)
		// We verify this by checking the excerpt can be re-encoded without issues
		expect(() => encodeURIComponent(detail)).not.toThrow();
	});

	test("tool.started with long JSON args slices at codepoint boundary", () => {
		// Build a JSON args object where the serialized form exceeds 80 chars and
		// contains astral codepoints
		const longVal = "🎉".repeat(50);
		const row = formatActivityRow(
			{
				offset: "23",
				kind: "tool.started",
				payload: { name: "emoji_tool", arguments: { key: longVal } },
			},
			NO_COLOR,
		);
		expect(row).not.toBeNull();
		// No lone surrogates — excerpt should be encode-safe
		const detail = row!.split("emoji_tool")[1] ?? "";
		expect(() => encodeURIComponent(detail)).not.toThrow();
	});
});

describe("@tedix/cli StatusSpinner", () => {
	test("quiet mode writes nothing", () => {
		const { writes, stream } = fakeStream();
		const spinner = new StatusSpinner({ animate: false, quiet: true, stream });
		spinner.start("Thinking");
		spinner.update("running");
		spinner.log("  · row");
		spinner.stop();
		expect(writes).toHaveLength(0);
	});

	test("quiet mode still forwards activity to an Ink-owned observer", () => {
		const observed: string[] = [];
		const spinner = new StatusSpinner({
			animate: false,
			quiet: true,
			onLog: (row) => observed.push(row),
		});
		spinner.log("✓ tool search_threads");
		expect(observed).toEqual(["✓ tool search_threads"]);
	});

	test("non-animated mode prints the label on change and rows plainly", () => {
		const { writes, stream } = fakeStream();
		const spinner = new StatusSpinner({ animate: false, quiet: false, stream });
		spinner.start("routing");
		spinner.update("routing"); // unchanged — no extra line
		spinner.log("  · submission admitted");
		spinner.update("completed");
		spinner.stop();
		const out = writes.join("");
		expect(out).toContain("... routing\n");
		expect(out).toContain("  · submission admitted\n");
		expect(out).toContain("... completed\n");
		// "routing" emitted once despite the duplicate update
		expect(writes.filter((w) => w === "... routing\n")).toHaveLength(1);
	});
});

describe("@tedix/cli StatusSpinner in-flight lines", () => {
	test("dismiss() drops an in-flight line without committing it; stop() commits the rest", () => {
		const { writes, stream } = fakeStream();
		const spinner = new StatusSpinner({
			animate: true,
			quiet: false,
			stream,
			color: NO_COLOR,
		});
		spinner.start("Working");
		spinner.log("  · thinking a provisional idea", {
			key: "thinking",
			phase: "start",
		});
		spinner.log("  ⠋ tool search_threads", { key: "tool:1", phase: "start" });
		expect(writes.join("")).toContain("thinking a provisional idea");
		spinner.dismiss("thinking");
		spinner.dismiss("thinking"); // unknown key: no-op, no extra render
		const afterDismiss = writes.length;
		spinner.stop();
		const committed = writes.slice(afterDismiss).join("");
		// Only the tool row survives teardown; the dismissed thinking line is
		// never written as scrollback.
		expect(committed).toContain("tool search_threads\n");
		expect(committed).not.toContain("thinking a provisional idea");
	});
});

describe("@tedix/cli streamed answer channel", () => {
	test("streamTailText collapses to one line and keeps the tail", () => {
		expect(streamTailText("  one\ntwo   three ", 40)).toBe("one two three");
		// `max` is the total budget INCLUDING the leading ellipsis.
		expect(streamTailText("abcdefghij", 5)).toBe("…ghij");
		expect(streamTailText("anything", 1)).toBe("");
	});

	test("an animated spinner renders the streamed answer on the live line", () => {
		const { writes, stream } = fakeStream();
		const spinner = new StatusSpinner({
			animate: true,
			quiet: false,
			stream,
			now: () => 0,
		});
		spinner.start("working");
		spinner.stream("Hello, this is the answer so far");
		const out = writes.join("");
		expect(out).toContain("Hello, this is the answer so far");
		// Live line only: nothing is committed to scrollback.
		expect(out).not.toContain("Hello, this is the answer so far\n");
		spinner.stop();
	});

	test("the settled signal drops the streamed fragment from the live line", () => {
		const { writes, stream } = fakeStream();
		const spinner = new StatusSpinner({
			animate: true,
			quiet: false,
			stream,
			now: () => 0,
		});
		spinner.start("working");
		spinner.stream("partial answer");
		writes.length = 0;
		spinner.stream("");
		const out = writes.join("");
		expect(out).not.toContain("partial answer");
		expect(out).toContain("working");
		spinner.stop();
	});

	test("quiet (--json) and non-TTY lanes stay byte-identical", () => {
		for (const mode of [
			{ animate: false, quiet: true },
			{ animate: false, quiet: false },
		]) {
			const { writes, stream } = fakeStream();
			const spinner = new StatusSpinner({ ...mode, stream });
			spinner.start("working");
			const before = writes.join("");
			spinner.stream("streamed text that must not appear");
			expect(writes.join("")).toBe(before);
			spinner.stop();
		}
	});

	test("streamed text reaches an Ink-owned observer even when quiet", () => {
		const observed: string[] = [];
		const spinner = new StatusSpinner({
			animate: false,
			quiet: true,
			onStream: (tail) => observed.push(tail),
		});
		spinner.stream("half an answer");
		spinner.stream("");
		expect(observed).toEqual(["half an answer", ""]);
	});
});

describe("@tedix/cli promote-in-place live region", () => {
	function promotingSpinner() {
		const { writes, stream } = fakeStream();
		const committed: string[] = [];
		const spinner = new StatusSpinner({
			animate: true,
			quiet: false,
			stream,
			now: () => 0,
			commit: (line) => committed.push(line),
			renderAnswer: (text) => text.split("\n"),
		});
		return { committed, spinner, stream, writes };
	}

	test("a stable block is committed to scrollback and leaves the live region", () => {
		const { committed, spinner, writes } = promotingSpinner();
		spinner.start("working");
		spinner.stream("First block of the answer.\n\nStill writ");
		expect(committed).toContain("First block of the answer.");
		writes.length = 0;
		// The live region now holds only the unstable tail — a committed line is
		// never drawn again.
		spinner.stream("First block of the answer.\n\nStill writing");
		const live = writes.join("");
		expect(live).toContain("Still writing");
		expect(live).not.toContain("First block of the answer.");
		spinner.stop();
	});

	test("a committed line is emitted exactly once as the stream grows", () => {
		const { committed, spinner } = promotingSpinner();
		spinner.start("working");
		const full = "one\n\ntwo\n\nthree";
		for (let cut = 1; cut <= full.length; cut++) {
			spinner.stream(full.slice(0, cut));
		}
		spinner.settleStream(full);
		spinner.stop();
		for (const body of ["one", "two", "three"]) {
			expect(committed.filter((line) => line === body)).toHaveLength(1);
		}
	});

	test("settle commits the tail and reports the prefix already in scrollback", () => {
		const { committed, spinner } = promotingSpinner();
		spinner.start("working");
		spinner.stream("Answer body");
		expect(committed).toEqual([]);
		const prefix = spinner.settleStream("Answer body");
		spinner.stop();
		expect(committed).toContain("Answer body");
		expect(prefix).toBe("Answer body");
		// The canonical summary has nothing left to print on top of it.
		expect(
			unrenderedAnswerText({
				assistantText: "Answer body",
				homeRunId: "r",
				renderedAnswerPrefix: prefix,
			}),
		).toBe("");
	});

	test("a run that never streamed promotes nothing and keeps the answer", () => {
		const { committed, spinner } = promotingSpinner();
		spinner.start("working");
		const prefix = spinner.settleStream("The whole answer");
		spinner.stop();
		expect(committed).toEqual([]);
		expect(prefix).toBe("");
		expect(
			unrenderedAnswerText({
				assistantText: "The whole answer",
				homeRunId: "r",
			}),
		).toBe("The whole answer");
	});

	test("an in-flight tool is one live line, replaced in place, then committed", () => {
		const { committed, spinner, writes } = promotingSpinner();
		spinner.start("working");
		const startEvent = {
			offset: "1",
			kind: "tool.started",
			payload: { name: "acme", callId: "c1" },
		};
		const endEvent = {
			offset: "2",
			kind: "tool.completed",
			payload: {
				name: "acme",
				callId: "c1",
				result: "218 results",
				latencyMs: 4900,
			},
		};
		const started = formatActivityRow(startEvent, NO_COLOR) as string;
		const finished = formatActivityRow(endEvent, NO_COLOR) as string;
		const startPhase = activityRowPhase(startEvent) as ActivityRowPhase;
		const endPhase = activityRowPhase(endEvent) as ActivityRowPhase;
		expect(startPhase).toEqual({ key: "c1", phase: "start" });
		expect(endPhase).toEqual({ key: "c1", phase: "end" });

		writes.length = 0;
		spinner.log(started, startPhase);
		const inFlight = writes.join("");
		// Live only: the in-flight row is not committed to scrollback yet.
		expect(inFlight).toContain("acme");
		expect(inFlight).not.toContain(`${started}\n`);
		// The bullet is swapped for the animated frame.
		expect(inFlight).toContain("⠋ tool acme");

		writes.length = 0;
		spinner.log(finished, endPhase);
		const settledRow = writes.join("");
		expect(settledRow).toContain("✓ tool");
		expect(settledRow).toContain("218 results");
		expect(settledRow).toContain("4.9s");
		// Committed once, and the in-flight line is gone from the live region.
		expect(settledRow.split("acme").length - 1).toBe(1);
		spinner.stop();
		// Answer promotion and activity rows use different sinks: activity stays on
		// the spinner stream.
		expect(committed).toEqual([]);
	});

	test("an in-flight row that never completes is committed on teardown", () => {
		const { spinner, writes } = promotingSpinner();
		spinner.start("working");
		spinner.log("  · tool orphan", { key: "c9", phase: "start" });
		writes.length = 0;
		spinner.stop();
		expect(writes.join("")).toContain("  · tool orphan\n");
	});
});

describe("@tedix/cli settled answer reconciliation", () => {
	test("a prefix that contradicts the canonical answer is ignored", () => {
		expect(
			unrenderedAnswerText({
				assistantText: "The real canonical answer",
				homeRunId: "r",
				renderedAnswerPrefix: "Something else entirely",
			}),
		).toBe("The real canonical answer");
	});

	test("only the part the user has not read is left for the summary", () => {
		expect(
			unrenderedAnswerText({
				assistantText: "read this\n\nbut not this",
				homeRunId: "r",
				renderedAnswerPrefix: "read this\n\n",
			}),
		).toBe("but not this");
	});
});
