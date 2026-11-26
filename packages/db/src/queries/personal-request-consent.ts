import type { DbClient } from "../client";
import { readAuditEventById } from "./audit-delivery";

/** Request consent is immutable admission evidence, never a caller-supplied claim. */
export async function getPersonalRequestConsent(
	db: DbClient,
	organizationId: string,
	runId: string,
) {
	const row = await readAuditEventById(
		db,
		organizationId,
		`personal-request:${organizationId}:${runId}`,
	);
	return row?.action === "personal.request.admitted" && row.actorType === "user"
		? row
		: undefined;
}
