import { describe, expect, test } from "bun:test";
import type { InFlightEntry } from "./inflight";
import {
	ACTIVITY_MAX,
	applyChildTreeProjection,
	humanizeActivity,
	isActivityNoise,
	LiveActivityPanel,
	parseChildCounts,
	parseChildPanelRows,
	parseRunSetSummaries,
	type RunState,
	renderChildPanelRow,
	renderPanel,
	renderPanelRow,
	truncateCp,
} from "./live-panel";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntry(overrides?: Partial<InFlightEntry>): InFlightEntry {
	return {
		homeRunId: "run-001",
		label: "test question",
		conversationId: "conv-1",
		startedAt: 1_000_000,
		settled: false,
		...overrides,
	};
}

function makeState(overrides?: Partial<RunState>): RunState {
	return {
		entry: makeEntry(),
		...overrides,
	};
}

const NOW = 1_008_200; // 8.2s after startedAt=1_000_000

// ─── truncateCp ──────────────────────────────────────────────────────────────

describe("truncateCp", () => {
	test("returns string unchanged when within limit", () => {
		expect(truncateCp("hello", 10)).toBe("hello");
	});

	test("truncates and appends ellipsis at codepoint boundary", () => {
		const result = truncateCp("abcdefghij", 5);
		expect(result).toBe("abcd…");
		expect([...result]).toHaveLength(5);
	});

	test("is surrogate-safe: counts emoji as one codepoint each", () => {
		const emoji = "🎉🎊🎈🎁🎀"; // 5 emoji = 5 codepoints, 10 UTF-16 units
		const result = truncateCp(emoji, 3);
		expect([...result]).toHaveLength(3);
		// Should contain 2 emoji + ellipsis, no broken surrogate
		expect(() => encodeURIComponent(result)).not.toThrow();
	});

	test("handles exact-length string without truncation", () => {
		expect(truncateCp("abcd", 4)).toBe("abcd");
	});

	test("truncates label longer than 24 chars to exactly 24 codepoints", () => {
		const long = "this is a very long question that exceeds 24 chars";
		const result = truncateCp(long, 24);
		expect([...result]).toHaveLength(24);
	});
});

describe("applyChildTreeProjection", () => {
	test("clears stale fan-out counts after the settled tree collapses", () => {
		const state = makeState();
		applyChildTreeProjection(
			state,
			{
				tree: {
					nodes: [
						{
							homeRunId: "run-001",
							children: [{ status: "completed", label: "Fan-out fp1" }],
						},
					],
				},
			},
			"run-001",
		);
		expect(state.childTotal).toBe(1);
		expect(state.childDone).toBe(1);

		applyChildTreeProjection(
			state,
			{ tree: { nodes: [{ homeRunId: "run-001", children: [] }] } },
			"run-001",
		);
		expect(state.childTotal).toBeUndefined();
		expect(state.childDone).toBeUndefined();
		expect(state.childFailed).toBeUndefined();
		expect(state.children).toEqual([]);
	});
});

// ─── humanizeActivity ────────────────────────────────────────────────────────

describe("humanizeActivity", () => {
	test("strips 'calling tedix_mcp_code' → 'running code'", () => {
		expect(humanizeActivity("calling tedix_mcp_code")).toBe("running code");
	});

	test("strips provider_tedix. prefix from tool: 'calling google_gmail_tedix.search_threads' → 'searching gmail'", () => {
		expect(humanizeActivity("calling google_gmail_tedix.search_threads")).toBe(
			"searching gmail",
		);
	});

	test("strips firecrawl_tedix.scrape_url → 'fetching page'", () => {
		expect(humanizeActivity("calling firecrawl_tedix.scrape_url")).toBe(
			"fetching page",
		);
	});

	test("already-clean activity passes through unchanged", () => {
		expect(humanizeActivity("searching gmail")).toBe("searching gmail");
		expect(humanizeActivity("streaming")).toBe("streaming");
		expect(humanizeActivity("running")).toBe("running");
	});

	test("applies verb heuristic for unrecognised snake_case tools", () => {
		// list_skills → "listing skills"
		expect(humanizeActivity("list_skills")).toBe("listing skills");
		// get_invoice → "reading invoice"
		expect(humanizeActivity("get_invoice")).toBe("reading invoice");
	});

	test("truncates result to ACTIVITY_MAX codepoints", () => {
		const long = `calling tedix_mcp_${"a".repeat(100)}`;
		const result = humanizeActivity(long);
		expect([...result].length).toBeLessThanOrEqual(ACTIVITY_MAX);
	});

	test("bare tedix_mcp_ prefix without suffix is cleaned up", () => {
		const result = humanizeActivity("calling tedix_mcp_web_search");
		expect(result).toBe("searching web");
	});

	test("acme list_invoices → 'listing invoices'", () => {
		expect(humanizeActivity("calling acme_tedix.list_invoices")).toBe(
			"listing invoices",
		);
	});
});

describe("isActivityNoise", () => {
	test("suppresses bare runtime-event counters that can move between projections", () => {
		expect(isActivityNoise("35 runtime events recorded")).toBe(true);
		expect(isActivityNoise("1 runtime event recorded")).toBe(true);
	});

	test("keeps useful activity text", () => {
		expect(isActivityNoise("searching gmail")).toBe(false);
	});
});

// ─── renderPanelRow ───────────────────────────────────────────────────────────

describe("renderPanelRow", () => {
	test("renders spinner frame, label, elapsed time", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("⠋"); // frame 0
		expect(row).toContain("test question");
		expect(row).toContain("8.2s");
	});

	test("rotates spinner frames", () => {
		const state = makeState();
		const row0 = renderPanelRow(state, 0, NOW);
		const row1 = renderPanelRow(state, 1, NOW);
		expect(row0).toContain("⠋");
		expect(row1).toContain("⠙");
	});

	// ── Route-kind hiding ──────────────────────────────────────────────────────

	test("route-kind 'delegate_tedi' never appears in the row", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				kernelRoute: { routeKind: "delegate_tedi" },
				targetTediLabel: "CEO",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("delegate_tedi");
	});

	test("route-kind 'answer_in_home' never appears in the row", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				kernelRoute: { routeKind: "answer_in_home" },
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("answer_in_home");
	});

	test("target tedi label still shown as '→ CEO' when route is present", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				kernelRoute: { routeKind: "delegate_tedi" },
				targetTediLabel: "CEO",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("→ CEO");
	});

	test("omits → when route and target are both absent", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("→");
	});

	test("includes target-only arrow when route is absent but target present", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				targetTediLabel: "CPO",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("→ CPO");
	});

	// ── Activity humanization ─────────────────────────────────────────────────

	test("'calling tedix_mcp_code' progressDetail renders as 'running code'", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				progressDetail: "calling tedix_mcp_code",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("running code");
		expect(row).not.toContain("tedix_mcp_code");
	});

	test("renders progressDetail as current activity", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				progressDetail: "searching gmail",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("searching gmail");
	});

	test("falls back to progressLabel when progressDetail absent", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				progressLabel: "streaming",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("streaming");
	});

	test("falls back to status when progressLabel absent", () => {
		const state = makeState({
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				status: "running",
			},
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("running");
	});

	// ── Right-aligned timing + cost ───────────────────────────────────────────

	test("elapsed is present in the row (right side)", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("8.2s");
	});

	test("omits token count when tokens absent", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("↓");
	});

	test("renders token count as '↓1.2k' (no trailing tok) when tokens=1200", () => {
		const state = makeState({ tokens: 1200 });
		const row = renderPanelRow(state, 0, NOW, 80);
		expect(row).toContain("↓1.2k");
		// The legacy "tok" suffix is gone from the right-side cost token
		expect(row).not.toContain("↓1.2k tok");
	});

	test("renders sub-1k token count as '↓800' without k suffix", () => {
		const state = makeState({ tokens: 800 });
		const row = renderPanelRow(state, 0, NOW, 80);
		expect(row).toContain("↓800");
	});

	test("elapsed and tokens are right-aligned: cost is near the end of the row at width 80", () => {
		const state = makeState({ tokens: 1200 });
		// "↓1.2k" is 5 chars, "8.2s" is 4 chars, " · " is 3 = cost is 12 chars
		const row = renderPanelRow(state, 0, NOW, 80);
		// Row should be exactly 80 chars wide when width is 80.
		expect([...row].length).toBe(80);
		// The cost should end at column 80.
		expect(row.endsWith("↓1.2k")).toBe(true);
	});

	test("elapsed right-aligned without tokens: row is exactly 'columns' chars at width 80", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW, 80);
		expect([...row].length).toBe(80);
		expect(row.endsWith("8.2s")).toBe(true);
	});

	test("falls back gracefully when row is wider than columns", () => {
		// A very narrow terminal (20 cols) should still produce a valid string.
		const state = makeState({ tokens: 1200 });
		const row = renderPanelRow(state, 0, NOW, 20);
		expect(row).toContain("8.2s");
		expect(typeof row).toBe("string");
	});

	// ── Child fan-out ─────────────────────────────────────────────────────────

	test("renders child fan-out as compact '2/3 done' (not 'children done')", () => {
		const state = makeState({ childTotal: 3, childDone: 2, childFailed: 0 });
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("2/3 done");
		expect(row).not.toContain("children");
	});

	test("renders child fan-out with failed count as '2/3 done · 1 failed'", () => {
		const state = makeState({ childTotal: 3, childDone: 2, childFailed: 1 });
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("2/3 done · 1 failed");
	});

	test("labels internal child branches as fan-out without implying the parent is done", () => {
		const state = makeState({
			childTotal: 2,
			childDone: 2,
			childFailed: 0,
			children: [
				{ id: "fp1", label: "Fan-out fp1", status: "completed" },
				{ id: "fp2", label: "Fan-out fp2", status: "completed" },
			],
		});
		const row = renderPanelRow(state, 0, NOW);
		expect(row).toContain("fan-out 2/2");
		expect(row).not.toContain("2/2 done");
	});

	test("omits child fan-out when childTotal is 0", () => {
		const state = makeState({ childTotal: 0, childDone: 0 });
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("done");
	});

	test("omits child fan-out when childTotal is undefined", () => {
		const state = makeState();
		const row = renderPanelRow(state, 0, NOW);
		expect(row).not.toContain("done");
	});

	// ── Label truncation ──────────────────────────────────────────────────────

	test("truncates label to 24 codepoints", () => {
		const longLabel = "this is a very long question exceeding 24 chars easily";
		const state = makeState({ entry: makeEntry({ label: longLabel }) });
		const row = renderPanelRow(state, 0, NOW);
		// The label in the row should be truncated
		const labelPart = row.slice(4, 4 + 24); // after "  ⠋ "
		expect([...labelPart]).toHaveLength(24);
	});

	test("is surrogate-safe for emoji labels", () => {
		const emojiLabel = "🎉".repeat(30); // 30 emoji = 30 codepoints
		const state = makeState({ entry: makeEntry({ label: emojiLabel }) });
		const row = renderPanelRow(state, 0, NOW);
		// Should not throw and should be encodable (no broken surrogates)
		expect(() => encodeURIComponent(row)).not.toThrow();
	});

	// ── Full CEO-row example (the canonical before/after) ────────────────────

	test("CEO row at 80 cols: calm layout, route hidden, activity humanized, timing right", () => {
		// BEFORE: "  ⠋ tell CEO to check my gm…   delegate_tedi → CEO · calling tedix_mcp_code · 53.6s"
		// AFTER:  "  ⠋ tell CEO to check my gm…   → CEO · running code               53.6s · ↓1.2k"
		const state: RunState = {
			entry: makeEntry({
				label: "tell CEO to check my gmail",
				startedAt: NOW - 53_600,
			}),
			summary: {
				homeRunId: "run-001",
				assistantText: "",
				kernelRoute: { routeKind: "delegate_tedi" },
				targetTediLabel: "CEO",
				progressDetail: "calling tedix_mcp_code",
			},
			tokens: 1200,
		};
		const row = renderPanelRow(state, 0, NOW, 80);

		// Route jargon absent
		expect(row).not.toContain("delegate_tedi");
		// Target present
		expect(row).toContain("→ CEO");
		// Activity humanized
		expect(row).toContain("running code");
		expect(row).not.toContain("tedix_mcp_code");
		// Timing right-aligned: row is exactly 80 cols, ends with token cost
		expect([...row].length).toBe(80);
		expect(row.endsWith("↓1.2k")).toBe(true);
		// Elapsed is in there too
		expect(row).toContain("53.6s");
	});
});

// ─── renderPanel ─────────────────────────────────────────────────────────────

describe("renderPanel", () => {
	test("returns empty array when no states", () => {
		expect(renderPanel([], 0, NOW)).toEqual([]);
	});

	test("first line is the header with run count", () => {
		const states = [makeState()];
		const lines = renderPanel(states, 0, NOW);
		expect(lines[0]).toBe("tedix [1 running]");
	});

	test("line count equals 1 + number of states (header + one per run)", () => {
		const states = [
			makeState({ entry: makeEntry({ homeRunId: "r1", label: "first" }) }),
			makeState({ entry: makeEntry({ homeRunId: "r2", label: "second" }) }),
			makeState({ entry: makeEntry({ homeRunId: "r3", label: "third" }) }),
		];
		const lines = renderPanel(states, 0, NOW);
		expect(lines).toHaveLength(4); // header + 3 rows
		expect(lines[0]).toBe("tedix [3 running]");
	});

	test("tracks line count for erase: N states → N+1 lines", () => {
		for (let n = 1; n <= 5; n++) {
			const states = Array.from({ length: n }, (_, i) =>
				makeState({
					entry: makeEntry({ homeRunId: `r${i}`, label: `run${i}` }),
				}),
			);
			const lines = renderPanel(states, 0, NOW);
			expect(lines).toHaveLength(n + 1);
		}
	});

	test("each row line starts with two spaces + spinner frame", () => {
		const states = [makeState()];
		const lines = renderPanel(states, 0, NOW);
		expect(lines[1]).toMatch(/^ {2}⠋/);
	});
});

// ─── parseChildCounts ────────────────────────────────────────────────────────

describe("parseChildCounts", () => {
	test("returns undefined when payload has no tree", () => {
		expect(parseChildCounts({}, "run-001")).toBeUndefined();
		expect(parseChildCounts(null, "run-001")).toBeUndefined();
		expect(parseChildCounts({ other: true }, "run-001")).toBeUndefined();
	});

	test("returns undefined when no nodes match the homeRunId", () => {
		const payload = {
			tree: {
				nodes: [{ homeRunId: "run-002", children: [] }],
			},
		};
		expect(parseChildCounts(payload, "run-001")).toBeUndefined();
	});

	test("returns undefined when matching node has no children", () => {
		const payload = {
			tree: {
				nodes: [{ homeRunId: "run-001", children: [] }],
			},
		};
		expect(parseChildCounts(payload, "run-001")).toBeUndefined();
	});

	test("counts total, done, and failed from children", () => {
		const payload = {
			tree: {
				nodes: [
					{
						homeRunId: "run-001",
						children: [
							{ id: "c1", status: "completed" },
							{ id: "c2", status: "failed" },
							{ id: "c3", status: "running" },
						],
					},
				],
			},
		};
		const result = parseChildCounts(payload, "run-001");
		expect(result).toEqual({ total: 3, done: 2, failed: 1 });
	});

	test("counts canceled children as done (not failed)", () => {
		const payload = {
			tree: {
				nodes: [
					{
						homeRunId: "run-001",
						children: [
							{ id: "c1", status: "canceled" },
							{ id: "c2", status: "canceled" },
						],
					},
				],
			},
		};
		const result = parseChildCounts(payload, "run-001");
		expect(result).toEqual({ total: 2, done: 2, failed: 0 });
	});

	test("handles multiple nodes for same homeRunId", () => {
		const payload = {
			tree: {
				nodes: [
					{
						homeRunId: "run-001",
						children: [{ id: "c1", status: "completed" }],
					},
					{
						homeRunId: "run-001",
						children: [{ id: "c2", status: "failed" }],
					},
				],
			},
		};
		const result = parseChildCounts(payload, "run-001");
		expect(result).toEqual({ total: 2, done: 2, failed: 1 });
	});
});

describe("coordinated child panel rows", () => {
	test("extracts calm tedi rows without exposing raw child run ids", () => {
		const rows = parseChildPanelRows(
			{
				tree: {
					nodes: [
						{
							homeRunId: "run-001",
							children: [
								{
									id: "child:tedi-cto:very-long-run-id",
									label: "CTO",
									status: "running",
									metadata: { objective: "Inspect the latest commit" },
								},
							],
						},
					],
				},
			},
			"run-001",
		);
		expect(rows).toEqual([
			{
				id: "child:tedi-cto:very-long-run-id",
				label: "CTO",
				status: "running",
				objective: "Inspect the latest commit",
			},
		]);
		const rendered = renderChildPanelRow(rows[0]!, 0);
		expect(rendered).toContain("CTO");
		expect(rendered).toContain("Inspect the latest commit");
		expect(rendered).not.toContain("very-long-run-id");
	});

	test("uses settled and approval markers", () => {
		expect(
			renderChildPanelRow({ id: "1", label: "CTO", status: "completed" }, 0),
		).toContain("✓ CTO");
		expect(
			renderChildPanelRow(
				{ id: "2", label: "CPO", status: "requires_approval" },
				0,
			),
		).toContain("◇ CPO");
	});
});

// ─── parseRunSetSummaries ────────────────────────────────────────────────────

describe("parseRunSetSummaries", () => {
	test("returns empty map for non-object input", () => {
		expect(parseRunSetSummaries(null).size).toBe(0);
		expect(parseRunSetSummaries(undefined).size).toBe(0);
		expect(parseRunSetSummaries("string").size).toBe(0);
	});

	test("extracts summaries from runSet.runs shape", () => {
		const payload = {
			runSet: {
				runs: [
					{
						id: "run-001",
						status: "running",
						progress: { label: "Thinking", detail: "searching" },
					},
				],
			},
		};
		const map = parseRunSetSummaries(payload);
		expect(map.size).toBe(1);
		const s = map.get("run-001");
		expect(s?.status).toBe("running");
		expect(s?.progressLabel).toBe("Thinking");
		expect(s?.progressDetail).toBe("searching");
	});

	test("extracts targetTediLabel from kernelRoute in metadata", () => {
		const payload = {
			runSet: {
				runs: [
					{
						id: "run-001",
						status: "running",
						metadata: {
							kernelRoute: {
								routeKind: "delegate_tedi",
								targetTediLabel: "CTO",
							},
						},
					},
				],
			},
		};
		const map = parseRunSetSummaries(payload);
		const s = map.get("run-001");
		expect(s?.targetTediLabel).toBe("CTO");
	});

	test("handles flat runs array without runSet wrapper", () => {
		const payload = {
			runs: [
				{
					id: "run-002",
					status: "completed",
				},
			],
		};
		const map = parseRunSetSummaries(payload);
		expect(map.has("run-002")).toBe(true);
	});

	test("uses homeRunId field when id is absent", () => {
		const payload = {
			runSet: {
				runs: [{ homeRunId: "run-003", status: "running" }],
			},
		};
		const map = parseRunSetSummaries(payload);
		expect(map.has("run-003")).toBe(true);
	});

	test("threads per-run token usage so the panel ↓N count lights up", () => {
		const payload = {
			runSet: {
				runs: [
					{
						id: "run-tok",
						status: "running",
						usage: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 },
					},
				],
			},
		};
		const map = parseRunSetSummaries(payload);
		expect(map.get("run-tok")?.usage?.totalTokens).toBe(1200);
	});

	test("skips runs without any id", () => {
		const payload = {
			runSet: {
				runs: [{ status: "running" }],
			},
		};
		const map = parseRunSetSummaries(payload);
		expect(map.size).toBe(0);
	});
});

// ─── LiveActivityPanel — TTY-off (non-TTY) ───────────────────────────────────

describe("LiveActivityPanel non-TTY", () => {
	test("add, settle, stop are no-ops when isTty=false", () => {
		const panel = new LiveActivityPanel({ isTty: false });
		const entry = makeEntry();
		// Should not throw
		expect(() => {
			panel.add(entry);
			panel.settle(entry.homeRunId);
			panel.stop();
		}).not.toThrow();
	});

	test("snapshot returns empty array on non-TTY panel", () => {
		const panel = new LiveActivityPanel({ isTty: false });
		expect(panel.snapshot()).toEqual([]);
	});
});

// ─── LiveActivityPanel — TTY data source ─────────────────────────────────────

describe("LiveActivityPanel TTY data source", () => {
	function makePanel() {
		return new LiveActivityPanel({ isTty: true, now: () => NOW });
	}

	test("snapshot includes header and one row per in-flight run", () => {
		const panel = makePanel();
		const entry = makeEntry({ label: "diana email" });
		panel.add(entry);
		const snap = panel.snapshot(NOW);
		expect(snap[0]).toContain("1 running");
		expect(snap[1]).toContain("diana email");
		panel.stop();
	});

	test("snapshot is empty after all runs settled", () => {
		const panel = makePanel();
		const entry = makeEntry();
		panel.add(entry);
		panel.settle(entry.homeRunId);
		expect(panel.snapshot(NOW)).toEqual([]);
		panel.stop();
	});

	test("records bounded, ANSI-free live activity without duplicating rows", () => {
		const panel = makePanel();
		const entry = makeEntry();
		panel.add(entry);
		panel.recordActivity(
			entry.homeRunId,
			"\u001b[32m✓ tool search_threads\u001b[0m",
		);
		panel.recordActivity(
			entry.homeRunId,
			"\u001b[32m✓ tool search_threads\u001b[0m",
		);
		expect(panel.findByPrefix(entry.homeRunId)?.activities).toEqual([
			"✓ tool search_threads",
		]);
		panel.stop();
	});

	test("the streamed answer tail is dynamic state cleared by the settled signal", () => {
		const panel = makePanel();
		const entry = makeEntry();
		panel.add(entry);
		panel.recordAnswerStream(
			entry.homeRunId,
			"\u001b[2mreading the ledger now\u001b[0m",
		);
		expect(panel.findByPrefix(entry.homeRunId)?.answerStream).toBe(
			"reading the ledger now",
		);
		// Never mixed into the committed activity rows.
		expect(panel.findByPrefix(entry.homeRunId)?.activities).toBeUndefined();
		panel.recordAnswerStream(entry.homeRunId, "");
		expect(panel.findByPrefix(entry.homeRunId)?.answerStream).toBeUndefined();
		panel.stop();
	});

	test("findByPrefix returns matching state", () => {
		const panel = makePanel();
		const entry = makeEntry({ homeRunId: "abc-def-123" });
		panel.add(entry);
		const found = panel.findByPrefix("abc-def");
		expect(found?.entry.homeRunId).toBe("abc-def-123");
		panel.stop();
	});

	test("findByPrefix returns undefined when no match", () => {
		const panel = makePanel();
		const entry = makeEntry({ homeRunId: "abc-def-123" });
		panel.add(entry);
		expect(panel.findByPrefix("xyz")).toBeUndefined();
		panel.stop();
	});

	test("stop() clears interval timers (can be called multiple times safely)", () => {
		const panel = makePanel();
		panel.add(makeEntry());
		panel.stop();
		// Second stop should not throw
		expect(() => panel.stop()).not.toThrow();
	});

	test("snapshot contains elapsed time for a running entry", () => {
		const panel = makePanel();
		const entry = makeEntry({ startedAt: NOW - 5000 });
		panel.add(entry);
		const snap = panel.snapshot(NOW);
		expect(snap.join("\n")).toContain("5.0s");
		panel.stop();
	});

	test("snapshot row omits token info when state has no tokens", () => {
		const panel = makePanel();
		panel.add(makeEntry());
		const snap = panel.snapshot(NOW);
		expect(snap.join("\n")).not.toContain("tok");
		panel.stop();
	});

	test("snapshot row contains token info when state has tokens", () => {
		const panel = makePanel();
		const entry = makeEntry();
		panel.add(entry);
		// Manually set tokens via snapshot-inspectable state via findByPrefix
		const state = panel.findByPrefix(entry.homeRunId);
		if (state) state.tokens = 2500;
		const snap = panel.snapshot(NOW);
		expect(snap.join("\n")).toContain("↓2.5k");
		panel.stop();
	});

	test("slow projection reads never overlap subsequent poll ticks", async () => {
		let calls = 0;
		const slowRead = async () => {
			calls++;
			await new Promise((resolve) => setTimeout(resolve, 30));
			return {};
		};
		const panel = new LiveActivityPanel({
			isTty: true,
			pollIntervalMs: 2,
			ops: {
				readHomeRunSet: slowRead,
				readChildRunTree: slowRead,
			},
		});
		panel.add(makeEntry());
		await new Promise((resolve) => setTimeout(resolve, 15));
		panel.stop();
		// One projection pair runs concurrently; later 2ms ticks are suppressed.
		expect(calls).toBe(2);
	});
});
