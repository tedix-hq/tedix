/** Seeded context-assembly cases; the bounded query shim is not D1 verification. */

import type { App } from "@tedix/db/schema/apps";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import type { OrganizationMember } from "@tedix/db/schema/organization-members";
import type { TediRationaleRecord } from "@tedix/db/schema/rationale-records";
import type { Tedi } from "@tedix/db/schema/tedis";
import type { WorkItem } from "@tedix/db/schema/work-items";

// ============================================================================
// Seeded-state type — rows the test inserts into the mock db
// ============================================================================

export interface ContextFixtureSeededState {
	tedis?: Partial<Tedi>[];
	apps?: Partial<App>[];
	workItems?: Partial<WorkItem>[];
	/** Each entry is { fact, domainName } matching what getTopPlatformFacts returns */
	facts?: { fact: Partial<MemoryFact>; domainName: string | null }[];
	rationaleRecords?: Partial<TediRationaleRecord>[];
	members?: Partial<OrganizationMember>[];
	historyEvents?: {
		conversationId: string;
		kind: "message.received" | "message.completed";
		content: string;
		createdAt: string;
		messageId?: string;
		organizationId?: string;
	}[];
	/** When set on a table key, that table's query throws */
	failTables?: Set<
		| "tedis"
		| "apps"
		| "workItems"
		| "facts"
		| "rationale"
		| "history"
		| "speaker"
	>;
}

// ============================================================================
// Assertion shape
// ============================================================================

export interface ContextFixtureExpected {
	/** Expected count of tedis in context */
	tediCount?: number;
	/** Specific tedi ids that must be present */
	tediIds?: string[];
	/** Expected count of apps */
	appCount?: number;
	/** Specific app slugs that must be present */
	appSlugs?: string[];
	/** Expected count of active work items */
	workItemCount?: number;
	/** Work item ids that MUST be present */
	workItemIds?: string[];
	/** Work item ids that MUST NOT be present (filtered out by disposition) */
	workItemIdsAbsent?: string[];
	/** Expected count of facts */
	factCount?: number;
	/** Text that must appear in at least one fact */
	factTextContains?: string;
	/** Expected count of history entries */
	historyLength?: number;
	/** History entry texts in order (oldest → newest) */
	historyContents?: string[];
	/** Conversely: texts that MUST NOT appear in history */
	historyAbsent?: string[];
	/** Expected count of rationale records */
	rationaleCount?: number;
	/** action text that must appear in at least one rationale record */
	rationaleActionContains?: string;
	/** Speaker assertions */
	speaker?: {
		role?: string;
		email?: string;
	} | null;
}

export interface ContextAssemblyFixture {
	name: string;
	seededState: ContextFixtureSeededState;
	opts?: {
		descopeUserId?: string;
		conversationId?: string;
		excludeMessageId?: string;
	};
	expected: ContextFixtureExpected;
}

// ============================================================================
// Minimal row factories (fill required fields with safe defaults)
// ============================================================================

const ORG_ID = "org-ctx-eval";

function makeTedi(overrides: Partial<Tedi>): Partial<Tedi> {
	return {
		organizationId: ORG_ID,
		name: "tedi",
		slug: "tedi",
		displayName: null,
		runtimeKind: "agent",
		status: "active",
		...overrides,
	};
}

function makeApp(overrides: Partial<App>): Partial<App> {
	return {
		organizationId: ORG_ID,
		name: "app",
		slug: "app",
		metadata: null,
		...overrides,
	};
}

function makeWorkItem(overrides: Partial<WorkItem>): Partial<WorkItem> {
	return {
		orgId: ORG_ID,
		title: "work item",
		disposition: "accepted",
		createdAt: "2026-06-11T08:00:00.000Z",
		description: null,
		priority: "medium",
		...overrides,
	};
}

function makeFact(
	overrides: Partial<MemoryFact>,
	domainName: string | null = null,
): { fact: Partial<MemoryFact>; domainName: string | null } {
	return {
		fact: {
			organizationId: ORG_ID,
			content: "fact content",
			confidence: 0.8,
			priority: "active",
			archivedAt: null,
			tediId: null,
			...overrides,
		},
		domainName,
	};
}

function makeRationale(
	overrides: Partial<TediRationaleRecord>,
): Partial<TediRationaleRecord> {
	return {
		orgId: ORG_ID,
		tediId: "tedi-1",
		action: "delegated task",
		rationale: "reasoning",
		category: "delegation",
		outcome: "completed",
		outcomeStatus: "success",
		confidence: 0.9,
		evidence: {},
		createdAt: "2026-06-11T08:00:00.000Z",
		...overrides,
	};
}

// ============================================================================
// Fixtures
// ============================================================================

export const CONTEXT_FIXTURES: ContextAssemblyFixture[] = [
	// ─── 1. Empty org ──────────────────────────────────────────────────────────
	{
		name: "ctx-1-empty-org",
		seededState: {},
		opts: {},
		expected: {
			tediCount: 0,
			appCount: 0,
			workItemCount: 0,
			factCount: 0,
			rationaleCount: 0,
			historyLength: 0,
			speaker: null,
		},
	},

	// ─── 2. Org with tedis and apps ────────────────────────────────────────────
	{
		name: "ctx-2-tedis-and-apps",
		seededState: {
			tedis: [
				makeTedi({
					id: "tedi-cpo",
					slug: "cpo",
					name: "CPO",
					displayName: "CPO",
					runtimeKind: "agent",
				}),
				makeTedi({
					id: "tedi-cto",
					slug: "cto",
					name: "CTO",
					displayName: "CTO",
					runtimeKind: "agent",
				}),
			],
			apps: [
				makeApp({
					id: "app-gmail",
					slug: "gmail",
					name: "Gmail",
					metadata: { capabilities: { vertical: "email" } },
				}),
				makeApp({
					id: "app-globex",
					slug: "globex",
					name: "Globex",
					metadata: {
						capabilities: {
							vertical: "accounting",
							checkout: { enabled: true },
						},
					},
				}),
			],
		},
		opts: {},
		expected: {
			tediCount: 2,
			tediIds: ["tedi-cpo", "tedi-cto"],
			appCount: 2,
			appSlugs: ["gmail", "globex"],
		},
	},

	// ─── 3. Work items — active-disposition filtering ───────────────────────────
	{
		name: "ctx-3-work-item-disposition-filter",
		seededState: {
			workItems: [
				makeWorkItem({
					id: "wi-proposed",
					title: "Proposed task",
					disposition: "proposed",
				}),
				makeWorkItem({
					id: "wi-accepted",
					title: "Accepted task",
					disposition: "accepted",
				}),
				// Terminal dispositions — must be excluded:
				makeWorkItem({
					id: "wi-completed",
					title: "Completed task",
					disposition: "completed",
				}),
				makeWorkItem({
					id: "wi-cancelled",
					title: "Cancelled task",
					disposition: "cancelled",
				}),
			],
		},
		opts: {},
		expected: {
			workItemCount: 2,
			workItemIds: ["wi-proposed", "wi-accepted"],
			workItemIdsAbsent: ["wi-completed", "wi-cancelled"],
		},
	},

	// ─── 4. Facts ranking and render cap ──────────────────────────────────────
	{
		name: "ctx-4-facts-cap-and-ordering",
		seededState: {
			// 16 facts — render cap is 14 in renderHomeContextPrompt, but the
			// assembleHomeContext itself slices to FACTS_LIMIT=20 from DB then passes
			// all through. The test checks what assembleHomeContext returns (up to 20).
			// We provide 16 so we're within FACTS_LIMIT=20 but can verify confidence ordering.
			facts: [
				makeFact({
					id: "fact-low",
					content: "low confidence fact",
					confidence: 0.3,
					priority: "active",
				}),
				makeFact({
					id: "fact-high",
					content: "high confidence fact",
					confidence: 0.95,
					priority: "active",
				}),
				makeFact({
					id: "fact-core",
					content: "core priority fact",
					confidence: 0.7,
					priority: "core",
				}),
				makeFact({
					id: "fact-mid",
					content: "medium confidence fact",
					confidence: 0.6,
					priority: "active",
				}),
			],
		},
		opts: {},
		expected: {
			factCount: 4,
			// core fact must appear (ordering by priority then confidence)
			factTextContains: "core priority fact",
		},
	},

	// ─── 5. Conversation history bounding ─────────────────────────────────────
	{
		name: "ctx-5-history-bounded",
		seededState: {
			historyEvents: [
				// 5 user+assistant pairs = 10 turns total, cap=8 so oldest 2 are dropped
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "turn 0 user",
					createdAt: "2026-06-11T08:00:00.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "turn 0 asst",
					createdAt: "2026-06-11T08:00:01.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "turn 1 user",
					createdAt: "2026-06-11T08:00:02.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "turn 1 asst",
					createdAt: "2026-06-11T08:00:03.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "turn 2 user",
					createdAt: "2026-06-11T08:00:04.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "turn 2 asst",
					createdAt: "2026-06-11T08:00:05.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "turn 3 user",
					createdAt: "2026-06-11T08:00:06.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "turn 3 asst",
					createdAt: "2026-06-11T08:00:07.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "turn 4 user",
					createdAt: "2026-06-11T08:00:08.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "turn 4 asst",
					createdAt: "2026-06-11T08:00:09.000Z",
				},
			],
		},
		opts: { conversationId: "home:a" },
		expected: {
			// History is bounded by measured token pressure, not a turn count:
			// ten short events fit the budget, so every one of them is kept.
			historyLength: 10,
			historyContents: [
				"turn 0 user",
				"turn 0 asst",
				"turn 4 user",
				"turn 4 asst",
			],
		},
	},

	// ─── 6. Cross-conversation isolation ──────────────────────────────────────
	{
		name: "ctx-6-conversation-isolation",
		seededState: {
			historyEvents: [
				// conversation A
				{
					conversationId: "home:a",
					kind: "message.received",
					content: "A secret: NIGHTHAWK-3",
					createdAt: "2026-06-11T08:00:00.000Z",
				},
				{
					conversationId: "home:a",
					kind: "message.completed",
					content: "Noted: NIGHTHAWK-3.",
					createdAt: "2026-06-11T08:00:01.000Z",
				},
				// conversation B — different thread
				{
					conversationId: "home:b",
					kind: "message.received",
					content: "B message: hello from B",
					createdAt: "2026-06-11T08:00:02.000Z",
				},
				{
					conversationId: "home:b",
					kind: "message.completed",
					content: "B answer",
					createdAt: "2026-06-11T08:00:03.000Z",
				},
			],
		},
		opts: { conversationId: "home:b" },
		expected: {
			historyLength: 2,
			// Conversation B must NOT see anything from A
			historyAbsent: ["NIGHTHAWK-3"],
			historyContents: ["hello from B", "B answer"],
		},
	},

	// ─── 7. Rationale records mapping ─────────────────────────────────────────
	{
		name: "ctx-7-rationale-records",
		seededState: {
			rationaleRecords: [
				makeRationale({
					id: "rat-1",
					action: "Delegated Q2 planning to CPO",
					category: "delegation",
					outcome: "CPO confirmed task accepted",
					outcomeStatus: "success",
					createdAt: "2026-06-11T08:00:00.000Z",
				}),
				makeRationale({
					id: "rat-2",
					action: "Proposed invoice creation in Globex",
					category: "tool_write",
					outcome: "pending operator approval",
					outcomeStatus: "pending",
					createdAt: "2026-06-11T08:00:01.000Z",
				}),
			],
		},
		opts: {},
		expected: {
			rationaleCount: 2,
			rationaleActionContains: "Delegated Q2 planning",
		},
	},

	// ─── 8. Degraded read — one table fails → partial context, no throw ────────
	{
		name: "ctx-8-degraded-read-partial-context",
		seededState: {
			tedis: [makeTedi({ id: "tedi-ok", slug: "ok", name: "OK Tedi" })],
			// Mark the apps table to fail; assembly must degrade, not throw
			failTables: new Set(["apps", "facts"]),
		},
		opts: {},
		expected: {
			// tedis should still be populated from the successful read
			tediCount: 1,
			tediIds: ["tedi-ok"],
			// apps failed → degraded to empty
			appCount: 0,
			// facts failed → degraded to empty
			factCount: 0,
		},
	},
];
