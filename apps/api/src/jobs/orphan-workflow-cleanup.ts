import type { DbClient } from "@tedix/db/client";
import {
	claimOrphanWorkflowCleanup,
	confirmOrphanWorkflowCleanup,
	listPendingOrphanWorkflowCleanups,
} from "@tedix/db/queries/cognitive-runtime-orphan-cleanup";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { cleanupOrphanRuntimeTurn } from "@tedix/provisioning";
import { getProvisioningConfig } from "../rpc/routers/tedis/helpers";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

/** Drain durable orphan failures independently of whether this tick sealed new rows. */
export async function cleanupOrphanWorkflows(db: DbClient, env: CloudflareEnv) {
	const pending = await listPendingOrphanWorkflowCleanups(db);
	const counts = {
		cleanupChecked: pending.length,
		cleanupConfirmed: 0,
		cleanupPending: 0,
	};
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, pending.length) }, async () => {
			while (cursor < pending.length) {
				const item = pending[cursor++];
				if (!item) break;
				try {
					if (!(await claimOrphanWorkflowCleanup(db, item))) continue;
					const tedi = await getTediByIdForOrganization(
						db,
						item.tediId,
						item.organizationId,
					);
					const config = tedi ? getProvisioningConfig(tedi, env) : null;
					const prefix = `${item.tediId}:mcp:`;
					if (!config || !item.runId.startsWith(prefix))
						throw new Error("Unverified orphan identity");
					const result = await cleanupOrphanRuntimeTurn(config, {
						clientRequestId: item.runId.slice(prefix.length),
						runId: item.runId,
						orphanedBefore: item.sealedAt,
					});
					if (
						!result.success ||
						!["terminated", "already_settled", "not_found"].includes(
							result.detail ?? "",
						)
					)
						throw new Error("Native cleanup unconfirmed");
					await confirmOrphanWorkflowCleanup(db, item, result.detail!);
					counts.cleanupConfirmed++;
				} catch (error) {
					// No receipt: the terminal row remains durable work after the retry cooldown.
					counts.cleanupPending++;
					console.warn("[Scheduled] orphan native cleanup pending", {
						terminalEventId: item.terminalEventId,
						exception: safeExceptionTopology(error),
					});
				}
			}
		}),
	);
	if (counts.cleanupChecked)
		console.log("[Scheduled] orphan native cleanup", counts);
	return counts;
}
