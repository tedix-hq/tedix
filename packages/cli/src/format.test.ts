import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	branchIdMatches,
	classifyEventCard,
	cyan,
	dim,
	emitEventNdjson,
	errorText,
	green,
	humanizeEventLabel,
	inspectTraceProjection,
	metadataRouteKind,
	printChildEvidencePayload,
	printInspectBundle,
	printReadPayload,
	printSummary,
	printUnknownPayload,
	red,
	renderEventPretty,
	resolveColorMode,
	routeKind,
	snippet,
	statusColor,
	summarizeEventIdGroups,
	yellow,
} from "./format";
import type { HomeRunEvent, HomeRunSummary } from "./home-client";
import { stringValue } from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { type ColorMode, stripControlChars } from "./terminal";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function captureLog(fn: () => void): string[] {
	const lines: string[] = [];
	const original = console.log;
	console.log = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	try {
		fn();
	} finally {
		console.log = original;
	}
	return lines;
}

function fakeSummary(overrides: Partial<HomeRunSummary> = {}): HomeRunSummary {
	return {
		homeRunId: "run-abc-123",
		assistantText: "Hello from the kernel",
		status: "completed",
		conversationId: "conv-1",
		...overrides,
	};
}

function fakeEvent(overrides: Partial<HomeRunEvent> = {}): HomeRunEvent {
	return {
		offset: "42",
		kind: "kernel.turn.completed",
		createdAt: "2026-06-18T10:00:00Z",
		id: "evt-1",
		payload: { answer: "done" },
		...overrides,
	};
}

// ─── resolveColorMode ─────────────────────────────────────────────────────────

describe("resolveColorMode", () => {
	let savedNoColor: string | undefined;
	let savedTerm: string | undefined;

	beforeEach(() => {
		savedNoColor = process.env.NO_COLOR;
		savedTerm = process.env.TERM;
		delete process.env.NO_COLOR;
		delete process.env.TERM;
	});

	afterEach(() => {
		if (savedNoColor === undefined) {
			delete process.env.NO_COLOR;
		} else {
			process.env.NO_COLOR = savedNoColor;
		}
		if (savedTerm === undefined) {
			delete process.env.TERM;
		} else {
			process.env.TERM = savedTerm;
		}
	});

	it("is disabled when json:true", () => {
		expect(resolveColorMode({ json: true, isTty: true })).toEqual({
			enabled: false,
		});
	});

	it("is disabled when noColor:true", () => {
		expect(resolveColorMode({ noColor: true, isTty: true })).toEqual({
			enabled: false,
		});
	});

	it("is disabled when NO_COLOR env is set", () => {
		process.env.NO_COLOR = "1";
		expect(resolveColorMode({ isTty: true })).toEqual({ enabled: false });
	});

	it("is disabled when TERM=dumb", () => {
		process.env.TERM = "dumb";
		expect(resolveColorMode({ isTty: true })).toEqual({ enabled: false });
	});

	it("is disabled when isTty is false", () => {
		expect(resolveColorMode({ isTty: false })).toEqual({ enabled: false });
	});

	it("is enabled only when all conditions pass", () => {
		expect(resolveColorMode({ isTty: true })).toEqual({ enabled: true });
	});

	it("is disabled when no opts (non-tty default)", () => {
		// In test environment stdout.isTTY is typically undefined/false
		const mode = resolveColorMode();
		// We just check it returns a ColorMode object; value depends on env
		expect(typeof mode.enabled).toBe("boolean");
	});
});

// ─── Color functions ──────────────────────────────────────────────────────────

describe("color fns", () => {
	const on: ColorMode = { enabled: true };
	const off: ColorMode = { enabled: false };

	it("green: returns raw text when disabled", () => {
		expect(green("hello", off)).toBe("hello");
	});

	it("green: wraps with ANSI when enabled", () => {
		expect(green("hello", on)).toBe("\x1b[32mhello\x1b[0m");
	});

	it("red: returns raw text when disabled", () => {
		expect(red("err", off)).toBe("err");
	});

	it("red: wraps with ANSI when enabled", () => {
		expect(red("err", on)).toBe("\x1b[31merr\x1b[0m");
	});

	it("yellow: wraps when enabled", () => {
		expect(yellow("warn", on)).toBe("\x1b[33mwarn\x1b[0m");
	});

	it("cyan: wraps when enabled", () => {
		expect(cyan("info", on)).toBe("\x1b[36minfo\x1b[0m");
	});

	it("dim: wraps when enabled", () => {
		expect(dim("muted", on)).toBe("\x1b[2mmuted\x1b[0m");
	});
});

// ─── statusColor ──────────────────────────────────────────────────────────────

describe("statusColor", () => {
	const on: ColorMode = { enabled: true };
	const off: ColorMode = { enabled: false };

	it("completed -> green", () => {
		expect(statusColor("completed", on)).toBe("\x1b[32mcompleted\x1b[0m");
	});

	it("failed -> red", () => {
		expect(statusColor("failed", on)).toBe("\x1b[31mfailed\x1b[0m");
	});

	it("canceled -> red", () => {
		expect(statusColor("canceled", on)).toBe("\x1b[31mcanceled\x1b[0m");
	});

	it("requires_approval -> yellow", () => {
		expect(statusColor("requires_approval", on)).toBe(
			"\x1b[33mrequires_approval\x1b[0m",
		);
	});

	it("running -> cyan", () => {
		expect(statusColor("running", on)).toBe("\x1b[36mrunning\x1b[0m");
	});

	it("active -> cyan", () => {
		expect(statusColor("active", on)).toBe("\x1b[36mactive\x1b[0m");
	});

	it("queued -> cyan", () => {
		expect(statusColor("queued", on)).toBe("\x1b[36mqueued\x1b[0m");
	});

	it("unknown status -> dim", () => {
		expect(statusColor("routing", on)).toBe("\x1b[2mrouting\x1b[0m");
	});

	it("undefined -> dim placeholder", () => {
		expect(statusColor(undefined, on)).toBe("\x1b[2m(none)\x1b[0m");
	});

	it("disabled mode returns raw text", () => {
		expect(statusColor("completed", off)).toBe("completed");
	});
});

// ─── emitEventNdjson ─────────────────────────────────────────────────────────

describe("emitEventNdjson", () => {
	it("emits a valid JSON line via injected write", () => {
		const captured: string[] = [];
		const event = fakeEvent();
		emitEventNdjson(event, (line) => captured.push(line));
		expect(captured).toHaveLength(1);
		const parsed = JSON.parse(captured[0] as string);
		expect(parsed.offset).toBe("42");
		expect(parsed.kind).toBe("kernel.turn.completed");
	});

	it("includes offset in the emitted line", () => {
		const captured: string[] = [];
		const event = fakeEvent({ offset: "99" });
		emitEventNdjson(event, (line) => captured.push(line));
		const parsed = JSON.parse(captured[0] as string);
		expect(parsed.offset).toBe("99");
	});

	it("serializes payload", () => {
		const captured: string[] = [];
		const event = fakeEvent({ payload: { foo: "bar" } });
		emitEventNdjson(event, (line) => captured.push(line));
		const parsed = JSON.parse(captured[0] as string);
		expect(parsed.payload).toEqual({ foo: "bar" });
	});

	it("emits full event round-trip", () => {
		const captured: string[] = [];
		const event: HomeRunEvent = {
			offset: "7",
			kind: "tedi.message.submitted",
			createdAt: "2026-01-01T00:00:00Z",
			id: "evt-xyz",
			payload: { text: "hello" },
		};
		emitEventNdjson(event, (line) => captured.push(line));
		expect(JSON.parse(captured[0] as string)).toEqual(event);
	});
});

// ─── renderEventPretty ────────────────────────────────────────────────────────

describe("renderEventPretty", () => {
	it("includes kind in output", () => {
		const event = fakeEvent();
		const result = renderEventPretty(event);
		expect(result).toContain("kernel.turn.completed");
	});

	it("includes offset in output", () => {
		const event = fakeEvent();
		const result = renderEventPretty(event);
		expect(result).toContain("offset=42");
	});

	it("includes createdAt when present", () => {
		const event = fakeEvent();
		const result = renderEventPretty(event);
		expect(result).toContain("2026-06-18T10:00:00Z");
	});

	it("includes payload snippet", () => {
		const event = fakeEvent({ payload: "the result text" });
		const result = renderEventPretty(event);
		expect(result).toContain("the result text");
	});

	it("renders without color when mode disabled", () => {
		const event = fakeEvent();
		const result = renderEventPretty(event, { enabled: false });
		expect(result).not.toContain("\x1b[");
	});

	it("renders with ANSI when color enabled", () => {
		const event = fakeEvent();
		const result = renderEventPretty(event, { enabled: true });
		expect(result).toContain("\x1b[");
	});

	it("handles event with no createdAt", () => {
		const event = fakeEvent({ createdAt: undefined });
		const result = renderEventPretty(event);
		expect(result).toContain("kernel.turn.completed");
		expect(result).toContain("offset=42");
	});

	it("handles event with string payload", () => {
		const event = fakeEvent({ payload: "short text" });
		const result = renderEventPretty(event);
		expect(result).toContain("short text");
	});
});

// ─── classifyEventCard / event cards ─────────────────────────────────────────

describe("classifyEventCard", () => {
	it("marks started/primary actions with ● (active)", () => {
		for (const kind of [
			"tool.started",
			"subagent.started",
			"skill.used",
			"run.started",
		]) {
			expect(classifyEventCard(kind)).toEqual({ marker: "●", tone: "active" });
		}
	});

	it("marks completions/results with ⎿ (ok)", () => {
		for (const kind of [
			"tool.completed",
			"subagent.completed",
			"run.completed",
			"step.completed",
		]) {
			expect(classifyEventCard(kind)).toEqual({ marker: "⎿", tone: "ok" });
		}
	});

	it("marks failures with ⎿ (error)", () => {
		for (const kind of [
			"tool.failed",
			"subagent.failed",
			"run.failed",
			"run.canceled",
		]) {
			expect(classifyEventCard(kind)).toEqual({ marker: "⎿", tone: "error" });
		}
	});

	it("marks retries + health changes with ⎿ (warn)", () => {
		expect(classifyEventCard("step.retry")).toEqual({
			marker: "⎿",
			tone: "warn",
		});
		expect(classifyEventCard("runtime.health_changed")).toEqual({
			marker: "⎿",
			tone: "warn",
		});
	});

	it("marks approval.requested with ● (warn)", () => {
		expect(classifyEventCard("approval.requested")).toEqual({
			marker: "●",
			tone: "warn",
		});
	});

	it("falls back to · (muted) for low-signal infra kinds", () => {
		for (const kind of [
			"message.received",
			"conversation.created",
			"context.injected",
			"unknown.kind",
		]) {
			expect(classifyEventCard(kind)).toEqual({ marker: "·", tone: "muted" });
		}
	});
});

describe("humanizeEventLabel", () => {
	it("returns the kind verbatim when no name in payload", () => {
		expect(
			humanizeEventLabel(fakeEvent({ kind: "run.started", payload: {} })),
		).toBe("run.started");
	});

	it("appends a tool name dug from the payload", () => {
		expect(
			humanizeEventLabel(
				fakeEvent({
					kind: "tool.started",
					payload: { toolName: "search_products" },
				}),
			),
		).toBe("tool.started · search_products");
	});

	it("falls back through name/skill", () => {
		expect(
			humanizeEventLabel(
				fakeEvent({ kind: "skill.used", payload: { skill: "site-search" } }),
			),
		).toBe("skill.used · site-search");
	});
});

describe("renderEventPretty card markers", () => {
	it("prepends ● for a started action", () => {
		const r = renderEventPretty(
			fakeEvent({ kind: "tool.started", payload: { toolName: "x" } }),
		);
		expect(r.startsWith("●")).toBe(true);
		expect(r).toContain("tool.started · x");
	});

	it("prepends ⎿ for a completion", () => {
		const r = renderEventPretty(
			fakeEvent({ kind: "run.completed", payload: {} }),
		);
		expect(r.startsWith("⎿")).toBe(true);
	});

	it("prepends · for infra noise", () => {
		const r = renderEventPretty(
			fakeEvent({ kind: "message.received", payload: {} }),
		);
		expect(r.startsWith("·")).toBe(true);
	});
});

// ─── printSummary snapshot-ish (existing behavior preserved) ─────────────────

describe("printSummary", () => {
	// The technical run=/status=/route= header is gated behind TEDIX_DEBUG; the
	// tests below assert that header, so they enable debug. The clean default
	// (header hidden) is covered by its own test.
	beforeEach(() => {
		process.env.TEDIX_DEBUG = "1";
	});
	afterEach(() => {
		delete process.env.TEDIX_DEBUG;
	});

	it("hides the run=/status= header by default (clean chat output)", () => {
		delete process.env.TEDIX_DEBUG;
		const summary = fakeSummary({ assistantText: "My answer here" });
		const lines = captureLog(() => printSummary(summary, false));
		const all = lines.join("\n");
		expect(all).not.toContain("run=run-abc-123");
		expect(all).not.toContain("status=completed");
		expect(all).toContain("My answer here");
	});

	it("outputs run header when color disabled", () => {
		const summary = fakeSummary();
		const lines = captureLog(() => printSummary(summary, false));
		const all = lines.join("\n");
		expect(all).toContain("run=run-abc-123");
		expect(all).toContain("status=completed");
	});

	it("outputs assistantText", () => {
		const summary = fakeSummary({ assistantText: "My answer here" });
		const lines = captureLog(() => printSummary(summary, false));
		expect(lines.join("\n")).toContain("My answer here");
	});

	it("prefers the delegated child result over a stale parent acknowledgment", () => {
		const summary = fakeSummary({
			assistantText: "I prepared a delegation. It is not dispatched yet.",
			childRunId: "child-1",
			childRunPreview: "Verified CMO result",
			delegationMode: "needs_approval",
			delegationStatus: "approved",
		});
		const all = captureLog(() => printSummary(summary, false)).join("\n");
		expect(all).toContain("Verified CMO result");
		expect(all).not.toContain("not dispatched yet");
		expect(all).not.toContain("Approval required");
	});

	it("emits JSON when json:true", () => {
		const summary = fakeSummary();
		const lines = captureLog(() => printSummary(summary, true));
		const parsed = JSON.parse(lines.join("\n"));
		expect(parsed.homeRunId).toBe("run-abc-123");
	});

	it("output is byte-identical to today when color disabled (no ANSI escapes)", () => {
		const summary = fakeSummary({ status: "running" });
		const lines = captureLog(() => printSummary(summary, false));
		const all = lines.join("\n");
		expect(all).not.toContain("\x1b[");
		expect(all).toContain("status=running");
	});

	it("wraps status token with ANSI when color enabled", () => {
		const summary = fakeSummary({ status: "completed" });
		const lines = captureLog(() =>
			printSummary(summary, false, { enabled: true }),
		);
		const all = lines.join("\n");
		expect(all).toContain("\x1b[32mcompleted\x1b[0m");
	});

	it("includes requires_approval notice", () => {
		const summary = fakeSummary({ status: "requires_approval" });
		const lines = captureLog(() => printSummary(summary, false));
		expect(lines.join("\n")).toContain("Approval required");
	});

	it("includes delegation error when present", () => {
		const summary = fakeSummary({ delegationError: "tedi unavailable" });
		const lines = captureLog(() => printSummary(summary, false));
		expect(lines.join("\n")).toContain("Delegation error: tedi unavailable");
	});

	it("includes resolved delegation status and note", () => {
		const summary = fakeSummary({
			childRunId: undefined,
			delegationMode: "needs_approval",
			delegationReason: "operator explicitly held dispatch for approval",
			delegationResolution: "Rejected during loop smoke.",
			delegationStatus: "rejected",
			status: "canceled",
		});

		const lines = captureLog(() => printSummary(summary, false));
		const all = lines.join("\n");
		expect(all).toContain("delegation=rejected");
		expect(all).toContain("Delegation decision: needs_approval");
		expect(all).toContain("Delegation status: rejected");
		expect(all).toContain("Delegation resolution: Rejected during loop smoke.");
	});

	it("includes approved delegation work-order scope when present", () => {
		const summary = fakeSummary({
			status: "queued",
			childRunId: "child-1",
			workItemId: "wi-approved-1",
			approvedDelegationWorkOrder: {
				status: "approved",
				objective:
					"The operator approved this previously parked delegation to CTO. Execute the intended delegated task now.",
				outputContract:
					"Return the completed delegated task result with concrete evidence.",
			},
		});

		const lines = captureLog(() => printSummary(summary, false));
		const all = lines.join("\n");
		expect(all).toContain("Approved delegation work order:");
		expect(all).toContain("workItem=wi-approved-1");
		expect(all).toContain("Execute the intended delegated task");
		expect(all).toContain("completed delegated task result");
	});
});

describe("printChildEvidencePayload", () => {
	it("includes linked Work Item id when present", () => {
		const lines = captureLog(() =>
			printChildEvidencePayload(
				{
					evidence: {
						childRunId: "child-1",
						delegatedTediId: "tedi-cto",
						status: "completed",
						latestEventKind: "run.completed",
						terminalEventKind: "run.completed",
						workItemId: "wi-child-1",
						events: [],
						artifacts: [],
					},
				},
				false,
			),
		);

		expect(lines.join("\n")).toContain("workItem=wi-child-1");
	});
});

// ─── routeKind ────────────────────────────────────────────────────────────────

describe("routeKind", () => {
	it("returns routeKind string from kernelRoute", () => {
		const summary = fakeSummary({
			kernelRoute: { routeKind: "direct" },
		});
		expect(routeKind(summary)).toBe("direct");
	});

	it("returns undefined when kernelRoute missing", () => {
		const summary = fakeSummary({ kernelRoute: undefined });
		expect(routeKind(summary)).toBeUndefined();
	});

	it("returns undefined when routeKind is not a string", () => {
		const summary = fakeSummary({ kernelRoute: { routeKind: 42 } });
		expect(routeKind(summary)).toBeUndefined();
	});
});

// ─── stripControlChars ───────────────────────────────────────────────────────

describe("stripControlChars", () => {
	it("strips ANSI CSI sequences", () => {
		expect(stripControlChars("\x1b[31mred\x1b[0m")).toBe("red");
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(stripControlChars("\x1b]0;title\x07normal")).toBe("normal");
	});

	it("strips OSC sequences terminated by ESC\\", () => {
		expect(
			stripControlChars("\x1b]8;;http://x.dev\x1b\\link\x1b]8;;\x1b\\"),
		).toBe("link");
	});

	it("strips lone ESC", () => {
		expect(stripControlChars("a\x1bb")).toBe("ab");
	});

	it("strips C0 control chars (NUL, BEL, BS, CR, etc.)", () => {
		expect(stripControlChars("\x00\x07\x08\x0D\x0E\x1F")).toBe("");
	});

	it("preserves \\n and \\t", () => {
		expect(stripControlChars("line1\nline2\ttab")).toBe("line1\nline2\ttab");
	});

	it("preserves printable ASCII", () => {
		expect(stripControlChars("Hello, World! 123")).toBe("Hello, World! 123");
	});

	it("preserves unicode including CJK and emoji", () => {
		expect(stripControlChars("日本語 🎉 café")).toBe("日本語 🎉 café");
	});

	it("strips stacked ANSI sequences", () => {
		expect(stripControlChars("\x1b[1m\x1b[32mbold green\x1b[0m\x1b[0m")).toBe(
			"bold green",
		);
	});

	it("strips DCS sequences", () => {
		expect(stripControlChars("\x1bPdata\x1b\\text")).toBe("text");
	});

	it("strips DEL (0x7F)", () => {
		expect(stripControlChars("a\x7fb")).toBe("ab");
	});
});

// ─── snippet ─────────────────────────────────────────────────────────────────

describe("snippet", () => {
	it("returns empty string for non-string values", () => {
		expect(snippet(null)).toBe("");
		expect(snippet(undefined)).toBe("");
		expect(snippet(42)).toBe("");
	});

	it("returns the full string when under maxLength", () => {
		expect(snippet("hello world")).toBe("hello world");
	});

	it("truncates with ellipsis when over maxLength", () => {
		const long = "a".repeat(200);
		const result = snippet(long, 140);
		expect(result).toHaveLength(140);
		expect(result.endsWith("...")).toBe(true);
	});

	it("collapses whitespace", () => {
		expect(snippet("hello   world")).toBe("hello world");
	});

	it("strips ANSI sequences from server-controlled text", () => {
		const injected = "\x1b[31mhello\x1b[0m world";
		expect(snippet(injected)).toBe("hello world");
	});

	it("maxLength <= 3 guard: returns sliced text without ellipsis", () => {
		expect(snippet("hello", 0)).toBe("");
		expect(snippet("hello", 1)).toBe("h");
		expect(snippet("hello", 3)).toBe("hel");
	});

	it("maxLength <= 3 guard: negative returns empty", () => {
		expect(snippet("hello", -1)).toBe("");
	});
});

// ─── errorText stacked prefixes ──────────────────────────────────────────────

// ─── isRecord / stringValue / metadataRouteKind ──────────────────────────────

describe("isRecord", () => {
	it("true for plain objects", () => {
		expect(isRecord({})).toBe(true);
	});

	it("false for arrays", () => {
		expect(isRecord([])).toBe(false);
	});

	it("false for null", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("false for strings", () => {
		expect(isRecord("x")).toBe(false);
	});
});

describe("stringValue", () => {
	it("returns value for non-empty strings", () => {
		expect(stringValue("hello")).toBe("hello");
	});

	it("returns undefined for empty/whitespace strings", () => {
		expect(stringValue("")).toBeUndefined();
		expect(stringValue("  ")).toBeUndefined();
	});

	it("returns undefined for non-strings", () => {
		expect(stringValue(42)).toBeUndefined();
		expect(stringValue(null)).toBeUndefined();
	});
});

describe("metadataRouteKind", () => {
	it("extracts routeKind from nested metadata.kernelRoute", () => {
		const record = {
			metadata: { kernelRoute: { routeKind: "delegated" } },
		};
		expect(metadataRouteKind(record)).toBe("delegated");
	});

	it("returns undefined when metadata is missing", () => {
		expect(metadataRouteKind({})).toBeUndefined();
	});
});

// ─── errorText ───────────────────────────────────────────────────────────────

describe("errorText", () => {
	it("returns message from Error", () => {
		expect(errorText(new Error("boom"))).toBe("boom");
	});

	it("converts non-Error to string", () => {
		expect(errorText("raw string")).toBe("raw string");
		expect(errorText(42)).toBe("42");
	});

	it("strips single oRPC prefix", () => {
		expect(errorText("NOT_FOUND: the resource was not found")).toBe(
			"the resource was not found",
		);
	});

	it("strips stacked oRPC prefixes", () => {
		expect(errorText("BAD_REQUEST: NOT_FOUND: the thing is missing")).toBe(
			"the thing is missing",
		);
	});

	it("strips MCP error prefix", () => {
		expect(errorText("MCP error -32600: bad request body")).toBe(
			"bad request body",
		);
	});

	it("trims surrounding whitespace before stripping", () => {
		expect(errorText("  BAD_REQUEST: trimmed  ")).toBe("trimmed");
	});
});

// ─── printReadPayload / printUnknownPayload undefined→null ───────────────────

describe("printReadPayload undefined→null JSON", () => {
	function captureLog(fn: () => void): string[] {
		const lines: string[] = [];
		const orig = console.log;
		console.log = (...args: unknown[]) =>
			lines.push(args.map((a) => String(a)).join(" "));
		try {
			fn();
		} finally {
			console.log = orig;
		}
		return lines;
	}

	it("serializes undefined payload as null in JSON mode", () => {
		const lines = captureLog(() => printReadPayload(undefined, true));
		expect(lines.join("")).toBe("null");
	});

	it("printUnknownPayload serializes undefined as null (json=true)", () => {
		const lines = captureLog(() => printUnknownPayload(undefined, true));
		expect(lines.join("")).toBe("null");
	});

	it("printUnknownPayload serializes undefined as null (json=false)", () => {
		const lines = captureLog(() => printUnknownPayload(undefined, false));
		expect(lines.join("")).toBe("null");
	});
});

// ─── printInspectBundle ───────────────────────────────────────────────────────

describe("printInspectBundle", () => {
	it("emits JSON when json:true", () => {
		const bundle = {
			homeRunId: "run-1",
			run: { run: { id: "run-1", status: "completed" } },
			summary: null,
		};
		const lines = captureLog(() => printInspectBundle(bundle, true));
		const parsed = JSON.parse(lines.join("\n"));
		expect(parsed.homeRunId).toBe("run-1");
	});

	it("prints a compact execution trace in text mode", () => {
		const bundle = {
			homeRunId: "run-1",
			run: { run: { id: "run-1", status: "completed" } },
			summary: null,
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: false,
					gaps: ["final_synthesis_missing"],
					latency: {
						parentElapsedMs: 61_000,
						maxWakeQueueMs: 450,
						finalWakeToSynthesisMs: 700,
					},
					health: {
						status: "unhealthy",
						counts: { errors: 1, warnings: 0 },
						findings: [],
					},
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-1",
							status: "completed",
							evidenceAvailable: true,
							truncated: false,
							eventIds: ["event-1"],
							toolEventIds: ["tool-1"],
							workstationEventIds: ["ws-1"],
							artifactIds: ["artifact-1"],
						},
					],
				},
			},
		};
		const lines = captureLog(() => printInspectBundle(bundle, false));
		const all = lines.join("\n");
		expect(all).toContain("== Home run ==");
		expect(all).toContain("== Execution trace ==");
		expect(all).toContain(
			"completed · incomplete · unhealthy health · 1 branch(es)",
		);
		expect(all).toContain("1 events · 1 tools · 1 workstation · 1 artifacts");
		expect(all).toContain(
			"Latency: 1m 1.0s total · 450ms wake max · 700ms final wake → synthesis",
		);
		expect(all).not.toContain('"eventIds"');
	});

	it("filters one branch and exposes only requested evidence ids", () => {
		const bundle = {
			homeRunId: "run-1",
			run: {},
			summary: null,
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: true,
					gaps: [],
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-1",
							status: "completed",
							evidenceAvailable: true,
							truncated: false,
							eventIds: ["event-1"],
							toolEventIds: ["tool-1"],
							workstationEventIds: ["ws-1"],
							artifactIds: ["artifact-1"],
						},
						{
							delegatedTediId: "security",
							childRunId: "child-2",
							status: "running",
							eventIds: [],
						},
					],
				},
			},
		};
		const projection = inspectTraceProjection(bundle, {
			branch: "child-1",
			artifacts: true,
			workstations: true,
		});
		expect(projection?.branches).toEqual([
			expect.objectContaining({
				childRunId: "child-1",
				artifactIds: ["artifact-1"],
				workstationEventIds: ["ws-1"],
			}),
		]);
	});

	it("matches --branch by prefix/suffix of the branch ids", () => {
		const bundle = {
			homeRunId: "run-1",
			run: {},
			summary: null,
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: true,
					gaps: [],
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-run-11112222",
							status: "completed",
							eventIds: [],
						},
						{
							delegatedTediId: "security",
							childRunId: "child-run-33334444",
							status: "running",
							eventIds: [],
						},
					],
				},
			},
		};
		// Suffix of the full child run id.
		const bySuffix = inspectTraceProjection(bundle, { branch: "11112222" });
		expect(bySuffix?.branches).toEqual([
			expect.objectContaining({ childRunId: "child-run-11112222" }),
		]);
		// Prefix that is longer than the stored id still matches (full id passed
		// for a branch row that stores a shortened form).
		const byLongerSelector = inspectTraceProjection(bundle, {
			branch: "child-run-33334444-extended",
		});
		expect(byLongerSelector?.branches).toEqual([
			expect.objectContaining({ childRunId: "child-run-33334444" }),
		]);
	});

	it("scopes text output to the branch and lists available ids on no match", () => {
		const bundle = {
			homeRunId: "run-1",
			run: {},
			summary: fakeSummary(),
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: true,
					gaps: [],
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-run-11112222",
							workItemId: "work-1",
							status: "completed",
							eventIds: [],
						},
					],
				},
			},
		};
		const matched = captureLog(() =>
			printInspectBundle(bundle, false, { branch: "11112222" }),
		).join("\n");
		// The full Home-run summary is suppressed; the filter is marked instead.
		expect(matched).not.toContain("== Home run ==");
		expect(matched).toContain("== Execution trace · branch 11112222 ==");
		expect(matched).toContain("child-run-11112222");

		const unmatched = captureLog(() =>
			printInspectBundle(bundle, false, { branch: "does-not-exist" }),
		).join("\n");
		expect(unmatched).toContain("No branch matched does-not-exist.");
		expect(unmatched).toContain("Available branches:");
		expect(unmatched).toContain("child-run-11112222 · cto · work-1");
	});

	it("renders --events as grouped counts instead of raw id joins", () => {
		const bundle = {
			homeRunId: "run-1",
			run: {},
			summary: null,
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: true,
					gaps: [],
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-1",
							status: "completed",
							eventIds: [
								"child-1:tool.0.started",
								"child-1:tool.0.completed",
								"child-1:tool.1.started",
								"child-1:tool.1.failed",
								"child-1:step:1:7",
								"child-1:directives:3",
								"child-1:emptystop:2",
								"mystery-event",
							],
							toolEventIds: [
								"child-1:tool.0.started",
								"child-1:tool.0.completed",
								"child-1:tool.1.started",
								"child-1:tool.1.failed",
							],
						},
					],
				},
			},
		};
		const all = captureLog(() =>
			printInspectBundle(bundle, false, { events: true }),
		).join("\n");
		expect(all).toContain(
			"events (8): tool.started ×2 · tool.completed ×1 · tool.failed ×1 · step ×1 · directives ×1 · emptystop ×1 · other ×1",
		);
		expect(all).not.toContain("event ids:");
		expect(all).not.toContain("tool ids:");
	});

	it("hydrates --events to readable rows from the childEvidence lane", () => {
		const bundle = {
			homeRunId: "run-1",
			run: {},
			summary: null,
			convergedTrace: {
				trace: {
					homeRunId: "run-1",
					status: "completed",
					complete: true,
					gaps: [],
					branches: [
						{
							delegatedTediId: "cto",
							childRunId: "child-1",
							status: "completed",
							eventIds: ["child-1:tool.0.started", "child-1:tool.0.completed"],
						},
					],
				},
			},
			childEvidence: {
				evidence: {
					childRunId: "child-1",
					events: [
						{
							id: "child-1:tool.0.started",
							kind: "tool.started",
							createdAt: "2026-07-13T10:00:00Z",
							payload: { name: "search_products" },
						},
						{
							id: "child-1:tool.0.completed",
							kind: "tool.completed",
							createdAt: "2026-07-13T10:00:05Z",
							payload: { name: "search_products" },
						},
					],
				},
			},
		};
		const all = captureLog(() =>
			printInspectBundle(bundle, false, { events: true }),
		).join("\n");
		expect(all).toContain(
			"● tool.started · search_products  2026-07-13T10:00:00Z",
		);
		expect(all).toContain(
			"⎿ tool.completed · search_products  2026-07-13T10:00:05Z",
		);
		expect(all).not.toContain("event ids:");
	});
});

// ─── branchIdMatches / summarizeEventIdGroups ────────────────────────────────

describe("branchIdMatches", () => {
	it("matches exact, prefix, and suffix forms", () => {
		expect(branchIdMatches("child-1", "child-1")).toBe(true);
		expect(branchIdMatches("child-run-abcd1234", "abcd1234")).toBe(true);
		expect(branchIdMatches("child-run-abcd1234", "child-run")).toBe(true);
		expect(branchIdMatches("abcd", "abcd1234")).toBe(true);
	});

	it("requires exact match for short selectors and rejects non-strings", () => {
		expect(branchIdMatches("child-run-abcd1234", "chi")).toBe(false);
		expect(branchIdMatches("abc", "abc")).toBe(true);
		expect(branchIdMatches(null, "abcd")).toBe(false);
		expect(branchIdMatches("child-run-abcd1234", "zzzz")).toBe(false);
	});
});

describe("summarizeEventIdGroups", () => {
	it("groups runtime event ids by their kind suffix", () => {
		expect(
			summarizeEventIdGroups([
				"run:tool.0.started",
				"run:tool.0.completed",
				"run:step:1:2",
				"run:step:2:9",
				"run:emptystop:1",
				"run:directives:4",
				"run:retry:1:3",
				"weird",
			]),
		).toBe(
			"tool.started ×1 · tool.completed ×1 · step ×2 · emptystop ×1 · directives ×1 · retry ×1 · other ×1",
		);
	});
});
