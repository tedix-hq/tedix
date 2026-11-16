import { CatalogSnapshotManifestSchema } from "@tedix/api-contract/schemas/catalog-snapshot";
import { ensureCatalogSnapshotSyncLog } from "@tedix/db/queries/catalog/sync-logs";
import { AUTHZ, createError, ErrorCodes } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { requireCatalogOperatorAccess } from "../catalog-operator-access";
import { fleetCatalogOs } from "./policy-quality";
import {
	captureCatalogSnapshot,
	assertSnapshotCaptureUrl,
} from "../../../lib/catalog-snapshot-capture";
import { snapshotPartKey } from "../../../workflows/catalog-snapshot-parts";

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
		// The manifest is written last, so its presence means every part is stored.
		let object = await env.R2_BUCKET.get(snapshotKey);
		if (!object) {
			// Name the cause for the operator: a bare failure here surfaced as an
			// unexplained 500 and its message is hashed in the logs.
			const manifest = await captureCatalogSnapshot(
				env.BROWSER,
				input.url,
				input.expression,
				async (part, items) => {
					for (const item of items) {
						const provenance = item.rawData?.[input.provenanceKey];
						if (
							!provenance ||
							typeof provenance !== "object" ||
							Array.isArray(provenance)
						)
							throw new Error(
								"Every listing must carry the declared feed provenance object",
							);
					}
					await env.R2_BUCKET.put(
						snapshotPartKey(snapshotKey, part),
						JSON.stringify(items),
						{ httpMetadata: { contentType: "application/json" } },
					);
				},
			).catch((error: unknown) => {
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					`Catalog capture failed: ${error instanceof Error ? error.message : String(error)}`.slice(
						0,
						500,
					),
				);
			});
			await env.R2_BUCKET.put(
				snapshotKey,
				JSON.stringify({ inputHash, manifest }),
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
			manifest: unknown;
		}>();
		if (archived.inputHash !== inputHash)
			throw createError(
				ErrorCodes.CONFLICT,
				"Snapshot id already belongs to different input",
			);
		const manifest = CatalogSnapshotManifestSchema.parse(archived.manifest);
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
			capturedSourceCount: manifest.capturedSourceCount,
			listingsCount: manifest.itemCount,
		};
	});
