import { ensureCatalogSnapshotSyncLog } from "@tedix/db/queries/catalog/sync-logs";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import { fleetCatalogOs } from "./policy-quality";
import { assertSnapshotCaptureUrl } from "../../../lib/catalog-snapshot-capture";

export const importCatalogSnapshot = fleetCatalogOs.importSnapshot
	.use(AUTHZ.catalogWrite)
	.handler(async ({ context, input }) => {
		requireCatalogOperatorAccess(context);
		const organizationId = requireOrgId(context);
		const { env, db } = context;
		if (!env.BROWSER || !env.CATALOG_SYNC_WORKFLOW)
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Catalog capture bindings unavailable",
			);
		assertSnapshotCaptureUrl(input.url);
		const inputHash = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(JSON.stringify(input)),
				),
			),
		)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const snapshotKey = `catalog/snapshots/${organizationId}/${input.snapshotId}.json`;
		// The capture itself runs inside the Workflow: a large directory takes
		// longer to read than a caller waits for one request.
		const log = await ensureCatalogSnapshotSyncLog(db, {
			id: input.snapshotId,
			syncType: "full",
			status: "running",
			startedAt: new Date().toISOString(),
			source: null,
			details: {
				source: input.feed,
				upstreamUrl: input.url,
				snapshotKey,
				snapshotOwner: organizationId,
				inputHash,
			},
		});
		if (
			log.details?.snapshotOwner !== organizationId ||
			log.details?.inputHash !== inputHash
		)
			throw createError(ErrorCodes.CONFLICT, "Snapshot id is already in use");
		const workflowInstanceId = `catalog-snapshot-${input.snapshotId}`;
		try {
			await env.CATALOG_SYNC_WORKFLOW.create({
				id: workflowInstanceId,
				params: {
					syncType: "full",
					source: "snapshot",
					syncLogId: log.id,
					snapshotKey,
					snapshotFeed: input.feed,
					snapshotUpstreamUrl: input.url,
					snapshotExpression: input.expression,
					snapshotProvenanceKey: input.provenanceKey,
					snapshotRemovalSources: input.removalSources,
					snapshotOwner: organizationId,
					snapshotInputHash: inputHash,
				},
			});
		} catch (error) {
			// Only an existing engine instance makes a repeated dispatch successful.
			try {
				await (
					await env.CATALOG_SYNC_WORKFLOW.get(workflowInstanceId)
				).status();
			} catch {
				throw error;
			}
		}
		return {
			success: true as const,
			syncLogId: log.id,
			workflowInstanceId,
			snapshotKey,
		};
	});
