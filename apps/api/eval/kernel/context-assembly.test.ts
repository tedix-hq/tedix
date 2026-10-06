/** Exercises context assembly, using a bounded query simulation rather than real D1. */
import { describe, expect, it } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import {
	apps,
	kernelRuntimeEvents,
	memoryFacts,
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

// ============================================================================
// Mock DB factory
// ============================================================================
// Builds a minimal Drizzle-compatible builder shim. Each `.from(table)` lookup
// routes to a per-table seeded row array. Tables in `failTables` throw so
// safeRead degrades them to empty. All other unsupported tables also throw
// (which safeRead also catches — defense-in-depth).
//
// Supported query shapes (matching what context-assembly.ts calls):
//
//   getTedisByOrganization  → select().from(tedis).where()
//   getAppsByOrganization   → select().from(apps).where()
//   listWorkItems           → select().from(workItems).where().orderBy().limit().offset()
//                           + $count(workItems, whereClause)
//   getTopPlatformFacts     → select({fact, domainName}).from(memoryFacts)
//                             .leftJoin().where().orderBy().limit()
//   listRationaleRecords    → select().from(tediRationaleRecords).where().orderBy().limit().offset()
//                           + $count(tediRationaleRecords, whereClause)
//   getMemberByUserId       → query.organizationMembers.findFirst({where})
//   fetchConversationHistory→ select().from(kernelRuntimeEvents).where().orderBy().limit()

type TableRef =
	| typeof tedis
	| typeof apps
	| typeof workItems
	| typeof memoryFacts
	| typeof tediRationaleRecords
	| typeof kernelRuntimeEvents
	| typeof organizationMembers;

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

function getTableName(table: TableRef): string {
	// Drizzle tables expose their symbol name via the [Symbol.for] pattern;
	// we compare by reference instead — simpler and more reliable.
	if (table === tedis) return "tedis";
	if (table === apps) return "apps";
	if (table === workItems) return "workItems";
	if (table === memoryFacts) return "facts";
	if (table === tediRationaleRecords) return "rationale";
	if (table === kernelRuntimeEvents) return "history";
	if (table === organizationMembers) return "speaker";
	return "unknown";
}

function createMockDb(seeded: SeededRows, failTables: FailTables): DbClient {
	// ──────────────────────────────────────────────────────────────────────────
	// WHERE / ORDER / LIMIT helpers (kept minimal — we only need to filter by
	// organizationId / orgId / conversationId and sort descending for the
	// history query; all other filters are ignored in favour of pre-seeded data)
	// ──────────────────────────────────────────────────────────────────────────

	function applyBasicWhere(
		rows: Record<string, unknown>[],
		whereClause: unknown,
	): Record<string, unknown>[] {
		// Walk the drizzle query-chunk tree and pull out equality conditions.
		const conditions: Array<{ key: string; value: unknown }> = [];
		function walk(node: unknown) {
			if (!node || typeof node !== "object") return;
			const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
			if (!Array.isArray(chunks)) return;
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i] as {
					name?: unknown;
					queryChunks?: unknown[];
					value?: unknown;
				};
				if (chunk?.queryChunks) {
					walk(chunk);
					continue;
				}
				if (typeof chunk?.name !== "string") continue;
				const opChunk = chunks[i + 1] as { value?: unknown } | undefined;
				const paramChunk = chunks[i + 2] as { value?: unknown } | undefined;
				const op = Array.isArray(opChunk?.value)
					? opChunk!.value.join("").trim()
					: "";
				if (op === "=" && paramChunk && "value" in paramChunk) {
					// Map column snake_case → camelCase
					const colToKey: Record<string, string> = {
						organization_id: "organizationId",
						org_id: "orgId",
						conversation_id: "conversationId",
						tedi_id: "tediId",
						id: "id",
						kind: "kind",
						status: "status",
						message_id: "messageId",
					};
					const key = colToKey[chunk.name] ?? chunk.name;
					conditions.push({ key, value: paramChunk.value });
				}
			}
		}
		walk(whereClause);
		if (conditions.length === 0) return rows;
		// Group by key so multiple values for the same key are treated as OR
		// (e.g. kind IN ("message.received", "message.completed"))
		const equalsByKey = new Map<string, Set<unknown>>();
		for (const { key, value } of conditions) {
			const existing = equalsByKey.get(key) ?? new Set<unknown>();
			existing.add(value);
			equalsByKey.set(key, existing);
		}
		return rows.filter((row) => {
			for (const [key, values] of equalsByKey) {
				if (!values.has(row[key] ?? null)) return false;
			}
			return true;
		});
	}

	function isDescOrder(order: unknown): boolean {
		const chunks = (order as { queryChunks?: unknown[] } | undefined)
			?.queryChunks;
		return Array.isArray(chunks)
			? chunks.some((c) => {
					const v = (c as { value?: unknown }).value;
					return (
						Array.isArray(v) &&
						v.some((s) => typeof s === "string" && s.includes(" desc"))
					);
				})
			: false;
	}

	function buildQueryBuilder(
		tableName: string,
		rawRows:
			| Record<string, unknown>[]
			| { fact: Record<string, unknown>; domainName: string | null }[],
	) {
		const isFactsTable = tableName === "facts";
		// For the facts table we return shaped rows {fact, domainName}; for others
		// we return plain rows.
		let rows: Record<string, unknown>[] = isFactsTable
			? (
					rawRows as {
						fact: Record<string, unknown>;
						domainName: string | null;
					}[]
				).map((r) => r as unknown as Record<string, unknown>)
			: (rawRows as Record<string, unknown>[]);

		let whereClause: unknown;
		let orderClause: unknown;
		let limitVal: number | undefined;
		let offsetVal = 0;

		return {
			where(w: unknown) {
				whereClause = w;
				return this;
			},
			orderBy(_o: unknown) {
				orderClause = _o;
				return this;
			},
			limit(n: number) {
				limitVal = n;
				return this;
			},
			offset(n: number) {
				offsetVal = n;
				return this;
			},
			leftJoin(_table: unknown, _on: unknown) {
				// leftJoin is only called for the facts query; rows already have the
				// {fact, domainName} shape from pre-seeded data — nothing to join.
				return this;
			},
			execute() {
				// Facts table: where clause filters against the `fact` sub-object's
				// organizationId field.
				let out: unknown[];
				if (isFactsTable) {
					const factRows = rawRows as {
						fact: Record<string, unknown>;
						domainName: string | null;
					}[];
					out = factRows.filter((r) => r.fact.organizationId === ORG_ID);
				} else {
					out = applyBasicWhere(rows, whereClause);
				}
				if (orderClause && isDescOrder(orderClause)) {
					out = [...out].sort((a, b) => {
						const av = isFactsTable
							? String(
									(a as { fact: { createdAt?: unknown } }).fact?.createdAt ??
										"",
								)
							: String(
									(a as Record<string, unknown>)?.updatedAt ??
										(a as Record<string, unknown>)?.createdAt ??
										"",
								);
						const bv = isFactsTable
							? String(
									(b as { fact: { createdAt?: unknown } }).fact?.createdAt ??
										"",
								)
							: String(
									(b as Record<string, unknown>)?.updatedAt ??
										(b as Record<string, unknown>)?.createdAt ??
										"",
								);
						return bv.localeCompare(av);
					});
				}
				out = out.slice(offsetVal);
				if (limitVal !== undefined) out = out.slice(0, limitVal);
				return out;
			},
			// The shim must implement Drizzle's awaitable query-builder contract.
			// eslint-disable-next-line unicorn/no-thenable
			then<R1, R2 = never>(
				onfulfilled?: ((v: unknown[]) => R1 | PromiseLike<R1>) | null,
				onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
			) {
				return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
			},
		};
	}

	const db = {
		// ── select() ────────────────────────────────────────────────────────────
		select(_shape?: unknown) {
			return {
				from(table: unknown) {
					const name = getTableName(table as TableRef);
					if (
						failTables.has(
							name as
								| "tedis"
								| "apps"
								| "workItems"
								| "facts"
								| "rationale"
								| "history"
								| "speaker",
						)
					) {
						throw new Error(`[mock] Simulated failure for table: ${name}`);
					}
					const rowsForTable:
						| Record<string, unknown>[]
						| { fact: Record<string, unknown>; domainName: string | null }[] =
						name === "tedis"
							? seeded.tedisRows
							: name === "apps"
								? seeded.appsRows
								: name === "workItems"
									? seeded.workItemRows
									: name === "facts"
										? seeded.factRows
										: name === "rationale"
											? seeded.rationaleRows
											: name === "history"
												? seeded.historyRows
												: [];
					return buildQueryBuilder(name, rowsForTable);
				},
			};
		},

		// ── batch() ─────────────────────────────────────────────────────────────
		// D1's transaction primitive, and the only one available: `db.transaction()`
		// throws against real D1 (error 7500), so any query that needs several
		// statements is written as a batch (the top-facts read is one). Without it
		// here, `db.batch is not a function` is swallowed by the caller's
		// try/catch and surfaces only as facts silently returning 0 rows.
		//
		// The builders below are thenables, so awaiting each one runs it. That
		// matches D1's read-batch semantics: results in statement order.
		batch(statements: readonly unknown[]): Promise<unknown[]> {
			return Promise.all(
				statements.map((statement) =>
					Promise.resolve(statement as PromiseLike<unknown>),
				),
			);
		},

		// ── $count() ────────────────────────────────────────────────────────────
		$count(table: unknown, whereClause?: unknown): Promise<number> {
			const name = getTableName(table as TableRef);
			if (
				failTables.has(
					name as
						| "tedis"
						| "apps"
						| "workItems"
						| "facts"
						| "rationale"
						| "history"
						| "speaker",
				)
			) {
				return Promise.reject(
					new Error(`[mock] Simulated $count failure for table: ${name}`),
				);
			}
			const rawRows: Record<string, unknown>[] =
				name === "workItems"
					? seeded.workItemRows
					: name === "rationale"
						? seeded.rationaleRows
						: [];
			const filtered = applyBasicWhere(rawRows, whereClause);
			return Promise.resolve(filtered.length);
		},

		// ── query.organizationMembers.findFirst() ────────────────────────────────
		query: {
			organizationMembers: {
				findFirst(opts?: {
					where?: Record<string, unknown>;
				}): Promise<Record<string, unknown> | undefined> {
					if (failTables.has("speaker")) {
						return Promise.reject(
							new Error("[mock] Simulated speaker read failure"),
						);
					}
					if (!opts?.where) {
						return Promise.resolve(seeded.memberRows[0]);
					}
					const { descopeUserId, organizationId } = opts.where as {
						descopeUserId?: unknown;
						organizationId?: unknown;
					};
					const found = seeded.memberRows.find((row) => {
						if (
							descopeUserId !== undefined &&
							row.descopeUserId !== descopeUserId
						)
							return false;
						if (
							organizationId !== undefined &&
							row.organizationId !== organizationId
						)
							return false;
						return true;
					});
					return Promise.resolve(found);
				},
			},
		},
	};

	return db as unknown as DbClient;
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
