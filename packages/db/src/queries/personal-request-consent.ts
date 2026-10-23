import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";

/** Request consent is immutable admission evidence, never a caller-supplied claim. */
export async function getPersonalRequestConsent(
	db: DbClient,
	organizationId: string,
	runId: string,
) {
	const [row] = await db
		.select()
		.from(auditEvents)
		.where(
			and(
				eq(auditEvents.id, `personal-request:${organizationId}:${runId}`),
				eq(auditEvents.organizationId, organizationId),
				eq(auditEvents.action, "personal.request.admitted"),
				eq(auditEvents.actorType, "user"),
			),
		)
		.limit(1);
	return row;
}
