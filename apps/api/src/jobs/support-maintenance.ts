import { createDbClient } from "@tedix/db/client";
import {
	getSupportConfiguration,
	listPendingSupportMirrors,
} from "@tedix/db/queries/support";
import { deliverSupportTicket } from "../services/support";

export async function maintainSupport(
	env: CloudflareEnv,
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB),
		config = await getSupportConfiguration(db);
	if (!config?.enabled) return { mirrors: 0 };
	let mirrors = 0;
	for (const ticket of await listPendingSupportMirrors(
		db,
		config.platformOrgId,
	)) {
		await deliverSupportTicket({ db }, ticket);
		mirrors++;
	}
	return { mirrors };
}
