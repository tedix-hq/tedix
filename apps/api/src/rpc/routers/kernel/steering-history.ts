import type { DbClient } from "@tedix/db/client";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import { listWithdrawnSteeringMessageIds } from "@tedix/db/queries/kernel-runtime-steering";

/** Keep the immutable ingress for audit, but never replay withdrawn user input. */
export async function excludeWithdrawnSteering(
	db: DbClient,
	organizationId: string,
	conversationId: string,
	rows: KernelRuntimeEvent[],
): Promise<KernelRuntimeEvent[]> {
	const messageIds = rows.flatMap((row) => {
		const metadata = row.payload?.metadata;
		return row.messageId &&
			metadata &&
			typeof metadata === "object" &&
			"steeringId" in metadata
			? [row.messageId]
			: [];
	});
	if (!messageIds.length) return rows;
	const withdrawn = new Set(
		await listWithdrawnSteeringMessageIds(db, {
			organizationId,
			conversationId,
			messageIds,
		}),
	);
	return rows.filter((row) => !row.messageId || !withdrawn.has(row.messageId));
}
