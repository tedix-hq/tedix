/** Exercises context assembly against the migrated SQLite ledger. */
import { describe, expect, it } from "vite-plus/test";
import { getTableName } from "drizzle-orm";
import { createApiSqliteFixture } from "../../src/rpc/routers/__tests__/api-sqlite";
import type { DbClient } from "@tedix/db/client";
import {
	apps,
	kernelRuntimeEvents,
	memoryFacts,
	memoryDomains,
	organizationMembers,
	tedis,
	tediRationaleRecords,
	workItems,
} from "@tedix/db/schema";
import {
	assembleHomeContext,
	type KernelContext,
} from "../../src/rpc/routers/kernel/context-assembly";
import {
	type ContextAssemblyFixture,
	type ContextFixtureExpected,
	CONTEXT_FIXTURES,
} from "./context-assembly-fixtures";

const ORG_ID = "org-ctx-eval";

interface SeededRows {
	tedisRows: Record<string, unknown>[];
	appsRows: Record<string, unknown>[];
	workItemRows: Record<string, unknown>[];
	factRows: { fact: Record<string, unknown>; domainName: string | null }[];
	rationaleRows: Record<string, unknown>[];
	historyRows: Record<string, unknown>[];
	memberRows: Record<string, unknown>[];
}

type FailTables = Set<
	"tedis" | "apps" | "workItems" | "facts" | "rationale" | "history" | "speaker"
>;

function createMockDb(seeded: SeededRows, failTables: FailTables): DbClient {
	const tables = {
		tedis,
		apps,
		workItems,
		facts: memoryFacts,
		rationale: tediRationaleRecords,
		history: kernelRuntimeEvents,
		speaker: organizationMembers,
	};
	const fixture = createApiSqliteFixture({
		onPrepare(query) {
			if (!/^select/i.test(query)) return;
			for (const key of failTables) {
				if (query.includes(`"${getTableName(tables[key])}"`))
					throw new Error(`[mock] Simulated failure for table: ${key}`);
			}
		},
	});
	fixture.seed(tedis, seeded.tedisRows);
	fixture.seed(apps, seeded.appsRows);
	fixture.seed(
		workItems,
		seeded.workItemRows.map((row) => ({
			admissionSpecRevision: `fixture-spec-${row.id}`,
			...row,
		})),
	);
	for (const { fact, domainName } of seeded.factRows) {
		const domainId = domainName ? `domain-${domainName}` : null;
		if (
			domainName &&
			!fixture.sqlite
				.prepare("select id from memory_domains where id = ?")
				.get(domainId)
		)
			fixture.seed(memoryDomains, [
				{ id: domainId, organizationId: ORG_ID, name: domainName },
			]);
		fixture.seed(memoryFacts, [
			{ factType: "technical", status: "active", ...fact, domainId },
		]);
	}
	fixture.seed(tediRationaleRecords, seeded.rationaleRows);
	fixture.seed(kernelRuntimeEvents, seeded.historyRows);
	fixture.seed(organizationMembers, seeded.memberRows);
	return fixture.db;
}

// ============================================================================
// Assertion engine
// ============================================================================

function assertContext(
	ctx: KernelContext,
	expected: ContextFixtureExpected,
): void {
	const counts = [
		[expected.tediCount, ctx.tedis],
		[expected.appCount, ctx.apps],
		[expected.workItemCount, ctx.workItems],
		[expected.factCount, ctx.facts],
		[expected.historyLength, ctx.history],
		[expected.rationaleCount, ctx.rationale],
	] as const;
	for (const [count, rows] of counts)
		if (count !== undefined) expect(rows).toHaveLength(count);
	for (const id of expected.tediIds ?? [])
		expect(ctx.tedis.map((row) => row.id)).toContain(id);
	for (const slug of expected.appSlugs ?? [])
		expect(ctx.apps.map((row) => row.slug)).toContain(slug);
	for (const id of expected.workItemIds ?? [])
		expect(ctx.workItems.map((row) => row.id)).toContain(id);
	for (const id of expected.workItemIdsAbsent ?? [])
		expect(ctx.workItems.map((row) => row.id)).not.toContain(id);
	if (expected.factTextContains !== undefined)
		expect(
			ctx.facts.some((row) => row.text.includes(expected.factTextContains!)),
		).toBe(true);
	for (const text of expected.historyContents ?? [])
		expect(ctx.history.some((row) => row.content.includes(text))).toBe(true);
	for (const text of expected.historyAbsent ?? [])
		expect(ctx.history.some((row) => row.content.includes(text))).toBe(false);
	if (expected.rationaleActionContains !== undefined)
		expect(
			ctx.rationale.some((row) =>
				row.action.includes(expected.rationaleActionContains!),
			),
		).toBe(true);
	if (expected.speaker === null) expect(ctx.speaker).toBeNull();
	else if (expected.speaker !== undefined)
		expect(ctx.speaker).toMatchObject(expected.speaker);
}

// ============================================================================
// History event row factory
// ============================================================================

let eventSeq = 0;
function makeHistoryRow(input: {
	conversationId: string;
	kind: "message.received" | "message.completed";
	content: string;
	createdAt: string;
	messageId?: string;
	organizationId?: string;
}): Record<string, unknown> {
	eventSeq += 1;
	return {
		id: `evt-${eventSeq}`,
		organizationId: input.organizationId ?? ORG_ID,
		kind: input.kind,
		conversationId: input.conversationId,
		runId: null,
		messageId: input.messageId ?? `msg-${eventSeq}`,
		delegatedTediId: null,
		childRunId: null,
		sequence: null,
		delta: null,
		payload: {
			role: input.kind === "message.received" ? "user" : "assistant",
			content: input.content,
		},
		runtimeBackend: "custom",
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		runtimeMetadata: null,
		createdAt: input.createdAt,
	};
}

// ============================================================================
// Fixture runner
// ============================================================================

async function runContextFixture(
	fixture: ContextAssemblyFixture,
): Promise<void> {
	const seededState = fixture.seededState;
	const failTables = seededState.failTables ?? new Set();

	const seeded: SeededRows = {
		tedisRows: (seededState.tedis ?? []).map((t) => ({
			organizationId: ORG_ID,
			name: "tedi",
			slug: "tedi",
			displayName: null,
			runtimeKind: "agent",
			status: "active",
			...t,
		})),
		appsRows: (seededState.apps ?? []).map((a) => ({
			organizationId: ORG_ID,
			name: "app",
			slug: "app",
			metadata: null,
			...a,
		})),
		workItemRows: (seededState.workItems ?? []).map((w) => ({
			orgId: ORG_ID,
			title: "work item",
			status: "accepted",
			createdAt: "2026-06-11T08:00:00.000Z",
			...w,
		})),
		factRows: (seededState.facts ?? []).map((f) => ({
			fact: {
				organizationId: ORG_ID,
				content: "fact",
				confidence: 0.8,
				priority: "active",
				archivedAt: null,
				validTo: null,
				reviewStatus: "confirmed",
				usePolicy: "can_use_as_evidence",
				visibility: "org",
				tediId: null,
				...f.fact,
			},
			domainName: f.domainName,
		})),
		rationaleRows: (seededState.rationaleRecords ?? []).map((r) => ({
			orgId: ORG_ID,
			tediId: "tedi-1",
			action: "action",
			category: "delegation",
			outcome: null,
			createdAt: "2026-06-11T08:00:00.000Z",
			...r,
		})),
		historyRows: (seededState.historyEvents ?? []).map(makeHistoryRow),
		memberRows: (seededState.members ?? []).map((m) => ({
			organizationId: ORG_ID,
			descopeUserId: "user-1",
			email: "operator@example.com",
			role: "owner",
			status: "active",
			...m,
		})),
	};

	const db = createMockDb(seeded, failTables);

	const ctx = await assembleHomeContext(db, ORG_ID, fixture.opts ?? {});
	assertContext(ctx, fixture.expected);
}

describe("kernel context assembly with seeded query responses", () => {
	it.each(CONTEXT_FIXTURES)("$name", async (fixture) => {
		await runContextFixture(fixture);
	});
});
