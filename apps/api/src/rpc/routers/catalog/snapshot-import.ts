import { CatalogSnapshotSchema } from "@tedix/api-contract/schemas/catalog-snapshot";
import { ensureCatalogSnapshotSyncLog } from "@tedix/db/queries/catalog/sync-logs";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import { fleetCatalogOs } from "./policy-quality";
import {
	captureCatalogSnapshot,
	assertSnapshotCaptureUrl,
} from "../../../lib/catalog-snapshot-capture";

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
		let object = await env.R2_BUCKET.get(snapshotKey);
		if (!object) {
			const snapshot = await captureCatalogSnapshot(
				env.BROWSER,
				input.url,
				input.expression,
			);
			for (const item of snapshot.items) {
				const provenance = item.rawData?.[input.provenanceKey];
				if (
					!provenance ||
					typeof provenance !== "object" ||
					Array.isArray(provenance)
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Every listing must carry the declared feed provenance object",
					);
			}
			await env.R2_BUCKET.put(
				snapshotKey,
				JSON.stringify({ inputHash, snapshot }),
				{
					onlyIf: { etagDoesNotMatch: "*" },
					httpMetadata: { contentType: "application/json" },
				},
			);
			object = await env.R2_BUCKET.get(snapshotKey);
		}
		if (!object)
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Snapshot archive missing after capture",
			);
		const archived = await object.json<{
			inputHash: string;
			snapshot: unknown;
		}>();
		if (archived.inputHash !== inputHash)
			throw createError(
				ErrorCodes.CONFLICT,
				"Snapshot id already belongs to different input",
			);
		const snapshot = CatalogSnapshotSchema.parse(archived.snapshot);
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
			capturedSourceCount: snapshot.capturedSourceCount,
			listingsCount: snapshot.items.length,
		};
	});
