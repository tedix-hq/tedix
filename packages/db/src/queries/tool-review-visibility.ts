import { sql } from "drizzle-orm";
import { appTools } from "../schema/tools";

/**
 * True when the row's stored definition is approved and may be offered.
 * A changed upstream tool waiting for review keeps its approved definition
 * live (`review_pending` holds the new one); only never-approved tools hide.
 */
export function toolDefinitionIsLive() {
	return sql`(coalesce(${appTools.reviewState}, 'live') = 'live' or ${appTools.reviewPending} is not null)`;
}
