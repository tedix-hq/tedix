import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workProjectHealthJudgments,
	type WorkHealthStatus,
	type WorkProjectHealthJudgment,
} from "../../schema/work-factory";
import {
	requireActivePrincipal,
	requireExternalSession,
	requireProject,
} from "./factory-validation";

export interface RecordWorkProjectHealthParams {
	id: string;
	orgId: string;
	projectId: string;
	status: WorkHealthStatus;
	summary: string;
	targetAt?: string | null;
	actorType: "user" | "tedi" | "external_agent" | "system";
	actorId: string;
	actorSessionId?: string;
	externalSessionKey?: string;
	metadata?: Record<string, JsonValue>;
	observedAt: string;
}
export async function recordWorkProjectHealthJudgment(
	db: DbQueryClient,
	p: RecordWorkProjectHealthParams,
): Promise<WorkProjectHealthJudgment> {
	await Promise.all([
		requireProject(db, p.orgId, p.projectId),
		requireActivePrincipal(db, {
			orgId: p.orgId,
			type: p.actorType,
			id: p.actorId,
		}),
	]);
	if (p.actorType === "external_agent") {
		if (!p.actorSessionId || !p.externalSessionKey)
			throw new Error(
				"External project-health actor requires an exact session fence",
			);
		await requireExternalSession(db, {
			orgId: p.orgId,
			principalId: p.actorId,
			sessionId: p.actorSessionId,
			externalSessionKey: p.externalSessionKey,
		});
	}
	return (
		await db
			.insert(workProjectHealthJudgments)
			.values({
				id: p.id,
				orgId: p.orgId,
				projectId: p.projectId,
				status: p.status,
				summary: p.summary,
				targetAt: p.targetAt,
				actorType: p.actorType,
				actorId: p.actorId,
				actorSessionId: p.actorSessionId,
				actorExternalSessionKey: p.externalSessionKey,
				metadata: p.metadata ?? {},
				observedAt: p.observedAt,
			})
			.returning()
	)[0]!;
}
export async function listWorkProjectHealthJudgments(
	db: DbQueryClient,
	p: {
		orgId: string;
		projectId: string;
		limit?: number;
		beforeObservedAt?: string;
	},
) {
	return db
		.select()
		.from(workProjectHealthJudgments)
		.where(
			and(
				eq(workProjectHealthJudgments.orgId, p.orgId),
				eq(workProjectHealthJudgments.projectId, p.projectId),
				p.beforeObservedAt
					? sql`${workProjectHealthJudgments.observedAt}<${p.beforeObservedAt}`
					: undefined,
			),
		)
		.orderBy(
			desc(workProjectHealthJudgments.observedAt),
			desc(workProjectHealthJudgments.id),
		)
		.limit(Math.min(p.limit ?? 50, 200));
}
