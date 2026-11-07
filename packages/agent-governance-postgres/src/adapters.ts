import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
	budgetForTier,
	evaluateCall,
	type ComplianceFacts,
} from "@tedix/agent-governance/compliance";
import { hashValue } from "@tedix/agent-governance/hash";
import type {
	Actor,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ChangeRecordInput,
	ComplianceDecision,
	GovernanceAdapters,
	LedgerQuery,
	MemoryEntry,
	MemoryProvenance,
	MemoryRevision,
	MemoryWriteInput,
} from "@tedix/agent-governance/types";
import { changeRecords, complianceDecisions, memoryRevisions } from "./schema";

export interface PostgresGovernanceOptions {
	/** One workspace/tenant boundary. Use a trusted scope, never a caller argument. */
	scope: string;
	/** Resolve current policy, caller scopes and approval receipts for each call. */
	facts?: (call: CallDescription) => Promise<ComplianceFacts>;
	now?: () => Date;
}

export function createPostgresAdapters(
	db: NodePgDatabase,
	options: PostgresGovernanceOptions,
): GovernanceAdapters {
	const { scope } = options;
	if (!scope) throw new Error("A governance storage scope is required");
	const now = options.now ?? (() => new Date());
	const revisionScope = eq(memoryRevisions.scope, scope);

	async function push(
		input: MemoryWriteInput,
		rolledBackFrom?: string,
	): Promise<MemoryRevision> {
		const body = {
			revisionId: crypto.randomUUID(),
			key: input.key,
			value: input.value,
			hash: await hashValue(input.value),
			writtenAt: now().toISOString(),
			provenance: input.provenance,
			review: input.review ?? "pending",
			...(rolledBackFrom ? { rolledBackFrom } : {}),
		};
		// Allocate and persist in one statement: competing writers serialize on the key row.
		const result = await db.execute<{ body: MemoryRevision }>(sql`
      WITH allocated AS (
        INSERT INTO memory_entries (scope, key, revision) VALUES (${scope}, ${input.key}, 1)
        ON CONFLICT (scope, key) DO UPDATE SET revision = memory_entries.revision + 1
        RETURNING revision
      )
      INSERT INTO memory_revisions (scope, revision_id, key, revision, body)
      SELECT ${scope}, ${body.revisionId}, ${input.key}, revision,
        ${JSON.stringify(body)}::jsonb || jsonb_build_object('revision', revision)
      FROM allocated RETURNING body
    `);
		return result.rows[0]!.body;
	}

	async function history(key: string): Promise<MemoryRevision[]> {
		const rows = await db
			.select({ body: memoryRevisions.body })
			.from(memoryRevisions)
			.where(and(revisionScope, eq(memoryRevisions.key, key)))
			.orderBy(asc(memoryRevisions.revision));
		return rows.map((r) => r.body);
	}
	async function read(key: string): Promise<MemoryEntry | null> {
		const revisions = await history(key);
		const current = revisions.at(-1);
		if (!current) return null;
		const approved = [...revisions]
			.reverse()
			.find((r) => r.review === "approved");
		return { key, current, ...(approved ? { approved } : {}) };
	}
	const memory: GovernanceAdapters["memory"] = {
		write: push,
		history,
		read,
		async list(prefix = "") {
			const rows = await db
				.select({ body: memoryRevisions.body })
				.from(memoryRevisions)
				.where(
					and(
						revisionScope,
						sql`starts_with(${memoryRevisions.key}, ${prefix})`,
					),
				)
				.orderBy(asc(memoryRevisions.key), asc(memoryRevisions.revision));
			const entries = new Map<string, MemoryEntry>();
			for (const { body } of rows) {
				const approved =
					body.review === "approved" ? body : entries.get(body.key)?.approved;
				entries.set(body.key, {
					key: body.key,
					current: body,
					...(approved ? { approved } : {}),
				});
			}
			return [...entries.values()];
		},
		async review(
			revisionId: string,
			decision: "approve" | "reject",
			reviewer: Actor,
			note?: string,
		) {
			const patch = {
				review: decision === "approve" ? "approved" : "rejected",
				reviewedBy: reviewer.id,
				reviewedAt: now().toISOString(),
				...(note ? { reviewNote: note } : {}),
			};
			const [row] = await db
				.update(memoryRevisions)
				.set({
					body: sql`${memoryRevisions.body} || ${JSON.stringify(patch)}::jsonb`,
				})
				.where(
					and(
						revisionScope,
						eq(memoryRevisions.revisionId, revisionId),
						sql`${memoryRevisions.body}->>'review' = 'pending'`,
					),
				)
				.returning({ body: memoryRevisions.body });
			if (row) return row.body;
			const [existing] = await db
				.select({ body: memoryRevisions.body })
				.from(memoryRevisions)
				.where(and(revisionScope, eq(memoryRevisions.revisionId, revisionId)));
			if (!existing) throw new Error(`Unknown memory revision ${revisionId}`);
			throw new Error(
				`Revision ${revisionId} was already ${existing.body.review}`,
			);
		},
		async rollback(
			key: string,
			toRevisionId: string,
			provenance: MemoryProvenance,
		) {
			const [target] = await db
				.select({ body: memoryRevisions.body })
				.from(memoryRevisions)
				.where(
					and(
						revisionScope,
						eq(memoryRevisions.key, key),
						eq(memoryRevisions.revisionId, toRevisionId),
					),
				);
			if (!target)
				throw new Error(`Revision ${toRevisionId} is not a revision of ${key}`);
			return push(
				{
					key,
					value: target.body.value,
					provenance,
					review: target.body.review === "approved" ? "approved" : "pending",
				},
				toRevisionId,
			);
		},
	};
	const ledgerScope = eq(changeRecords.scope, scope);
	function record(row: typeof changeRecords.$inferSelect): ChangeRecord {
		return Object.freeze({
			...row.body,
			id: row.id,
			sequence: row.sequence,
			recordedAt: row.recordedAt,
		});
	}
	const accountability: GovernanceAdapters["accountability"] = {
		async append(input: ChangeRecordInput) {
			// The scope row serializes commits as well as allocation, so a cursor cannot skip a late commit.
			const result = await db.execute<{
				id: string;
				sequence: string;
				recorded_at: string;
				body: ChangeRecordInput;
			}>(sql`
              WITH allocated AS (
                INSERT INTO change_record_heads (scope, sequence) VALUES (${scope}, 1)
                ON CONFLICT (scope) DO UPDATE SET sequence = change_record_heads.sequence + 1
                RETURNING sequence
              )
              INSERT INTO change_records (scope, id, sequence, recorded_at, resource, actor_id, body)
              SELECT ${scope}, ${crypto.randomUUID()}, sequence, ${now().toISOString()}, ${input.resource}, ${input.actor.id}, ${JSON.stringify(input)}::jsonb
              FROM allocated RETURNING id, sequence, recorded_at, body
            `);
			const row = result.rows[0]!;
			return Object.freeze({
				...row.body,
				id: row.id,
				sequence: Number(row.sequence),
				recordedAt: row.recorded_at,
			});
		},
		async list(query: LedgerQuery = {}) {
			const statement = db
				.select()
				.from(changeRecords)
				.where(
					and(
						ledgerScope,
						query.resource === undefined
							? undefined
							: eq(changeRecords.resource, query.resource),
						query.actorId === undefined
							? undefined
							: eq(changeRecords.actorId, query.actorId),
						query.afterSequence === undefined
							? undefined
							: gt(changeRecords.sequence, query.afterSequence),
					),
				)
				.orderBy(asc(changeRecords.sequence))
				.$dynamic();
			const rows = await (query.limit === undefined
				? statement
				: statement.limit(query.limit));
			return rows.map(record);
		},
		async get(id: string) {
			const [row] = await db
				.select()
				.from(changeRecords)
				.where(and(ledgerScope, eq(changeRecords.id, id)));
			return row ? record(row) : null;
		},
		async export() {
			return {
				exportedAt: now().toISOString(),
				records: await accountability.list(),
			};
		},
	};
	const compliance: GovernanceAdapters["compliance"] = {
		async check(call: CallDescription) {
			const facts = options.facts
				? await options.facts(call)
				: {
						riskTier: call.riskTier,
						blastRadius: call.blastRadius,
						destructive: call.destructive,
						approval: "not_required" as const,
					};
			const budget = budgetForTier(facts.riskTier);
			if (!budget) return evaluateCall(facts);
			const key = JSON.stringify([
				call.actor.organizationId ?? "",
				call.actor.id,
				call.resource,
			]);
			const timestamp = now().getTime();
			// A bounded rolling window, shared by all adapter instances in this scope.
			const result = await db.execute<{ key: string }>(sql`
        INSERT INTO compliance_rate_windows AS w (scope, key, calls)
        VALUES (${scope}, ${key}, ARRAY[${timestamp}::bigint])
        ON CONFLICT (scope, key) DO UPDATE SET calls = (
          SELECT coalesce(array_agg(t ORDER BY t), ARRAY[]::bigint[]) || ${timestamp}::bigint
          FROM unnest(w.calls) AS t WHERE t > ${timestamp - budget.windowSeconds * 1000}
        )
        WHERE (SELECT count(*) FROM unnest(w.calls) AS t WHERE t > ${timestamp - budget.windowSeconds * 1000}) < ${budget.limit}
        RETURNING key
      `);
			const limited = result.rows.length === 0;
			return evaluateCall({
				...facts,
				rate: {
					limited,
					scope: "organization_caller_app_tool",
					...(limited ? { retryAfterSeconds: budget.windowSeconds } : {}),
				},
			});
		},
		async record(
			call: CallDescription,
			decision: ComplianceDecision,
			outcome: CallOutcome,
		) {
			const { args, ...description } = call;
			await db.insert(complianceDecisions).values({
				scope,
				id: crypto.randomUUID(),
				recordedAt: now().toISOString(),
				call: { ...description, argsHash: await hashValue(args) },
				decision,
				outcome,
			});
		},
	};
	return { memory, accountability, compliance };
}
