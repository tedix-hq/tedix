/**
 * oRPC Images Router
 * Manage entity images (organizations, apps, tedis) via Cloudflare Images
 * Direct Creator Upload. The browser uploads straight to a one-time upload URL;
 * the server confirms the upload, stores the public delivery URL on the entity,
 * and cleans up any previously stored Cloudflare image.
 */

import { implement } from "@orpc/server";
import { imagesContract } from "@tedix/api-contract/contracts/images";
import {
	hasPermission,
	type Permission,
	roleImpliesPermission,
} from "@tedix/auth/rbac";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	getEntityImageUrl,
	listLegacyEntityImagesForPlatform,
	updateEntityImageUrl,
	updateEntityImageUrlForPlatform,
} from "@tedix/db/queries/entity-images";
import { getTediById } from "@tedix/db/queries/tedis";
import { hasScope } from "@tedix/mcp-shared/auth/scopes";
import {
	buildDeliveryUrl,
	deleteCfImage,
	extractImageId,
	getCfImage,
	importImageFromUrl,
	requestDirectUpload,
	uploadImageBytes,
} from "../../lib/cf-images";
import {
	type BaseContext,
	createError,
	createScopeMiddleware,
	ErrorCodes,
	withAuth,
} from "../orpc";

type EntityType = "organization" | "app" | "tedi";

const imagesOs = implement(imagesContract).$context<BaseContext>();
const authedImagesOs = imagesOs.use(withAuth);

// =============================================================================
// UPLOAD (server-side, base64 — programmatic/MCP path)
// =============================================================================

export const uploadImageContract = authedImagesOs.upload.handler(
	async ({ context, input }) => {
		const { entityType, entityId, fileData, contentType, filename } = input;
		const { env, organizationId } = context;
		assertEntityImageAuthorization(context, entityType);

		if (!organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		await verifyEntityOwnership(context, entityType, entityId);

		const bytes = Uint8Array.from(atob(fileData), (c) => c.charCodeAt(0));
		const { id } = await uploadImageBytes(env, bytes.buffer as ArrayBuffer, {
			filename,
			contentType,
			metadata: { entityType, entityId, organizationId },
		});

		// Clean up the previously stored Cloudflare image, if any.
		const previousUrl = await getEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
		});
		const previousId = extractImageId(previousUrl);
		if (previousId && previousId !== id) {
			await deleteCfImage(env, previousId).catch(() => {});
		}

		const url = buildDeliveryUrl(env.CF_ACCOUNT_HASH, id);
		await updateEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
			url,
		});

		return { url, key: id };
	},
);

// =============================================================================
// REQUEST UPLOAD (step 1)
// =============================================================================

export const requestUploadContract = authedImagesOs.requestUpload.handler(
	async ({ context, input }) => {
		const { entityType, entityId } = input;
		const { env, organizationId } = context;
		assertEntityImageAuthorization(context, entityType);

		if (!organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		await verifyEntityOwnership(context, entityType, entityId);

		const { id, uploadURL } = await requestDirectUpload(env, {
			metadata: { entityType, entityId, organizationId },
		});

		return { imageId: id, uploadURL };
	},
);

// =============================================================================
// CONFIRM UPLOAD (step 2)
// =============================================================================

export const confirmUploadContract = authedImagesOs.confirmUpload.handler(
	async ({ context, input }) => {
		const { entityType, entityId, imageId } = input;
		const { env, organizationId } = context;
		assertEntityImageAuthorization(context, entityType);

		if (!organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		await verifyEntityOwnership(context, entityType, entityId);

		// Confirm the Direct Creator Upload actually landed before we bind it.
		const image = await getCfImage(env, imageId);
		if (!image) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Uploaded image not found; the upload may not have completed",
			);
		}

		// Clean up the previously stored Cloudflare image, if any.
		const previousUrl = await getEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
		});
		const previousId = extractImageId(previousUrl);
		if (previousId && previousId !== imageId) {
			await deleteCfImage(env, previousId).catch(() => {});
		}

		const url = buildDeliveryUrl(env.CF_ACCOUNT_HASH, imageId);
		await updateEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
			url,
		});

		return { url, imageId };
	},
);

// =============================================================================
// DELETE
// =============================================================================

export const deleteImageContract = authedImagesOs.delete.handler(
	async ({ context, input }) => {
		const { entityType, entityId } = input;
		const { env, organizationId } = context;
		assertEntityImageAuthorization(context, entityType);

		if (!organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		await verifyEntityOwnership(context, entityType, entityId);

		const currentUrl = await getEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
		});
		const imageId = extractImageId(currentUrl);
		if (imageId) {
			await deleteCfImage(env, imageId);
		}
		await updateEntityImageUrl(context.db, {
			entityType,
			entityId,
			organizationId,
			url: null,
		});

		return { success: true };
	},
);

// =============================================================================
// BACKFILL (platform-admin one-off: r2.dev -> Cloudflare Images)
// =============================================================================

export const backfillContract = authedImagesOs.backfill
	.use(createScopeMiddleware("platform:admin"))
	.handler(async ({ context, input }) => {
		assertAuthorization(context, "platform:admin", "platform:admin");
		const { env, db } = context;
		const dryRun = input.dryRun;
		const limit = input.limit;
		const types =
			input.entityTypes ?? (["organization", "app", "tedi"] as const);

		const results: Record<EntityType, BackfillCounts> = {
			organization: emptyCounts(),
			app: emptyCounts(),
			tedi: emptyCounts(),
		};
		const migrated: Array<{
			entityType: EntityType;
			entityId: string;
			oldUrl: string;
			newUrl: string;
		}> = [];
		const errors: Array<{
			entityType: EntityType;
			entityId: string;
			error: string;
		}> = [];

		for (const entityType of types) {
			const rows = (
				await listLegacyEntityImagesForPlatform(db, entityType, limit)
			).filter((row): row is { id: string; url: string } =>
				isMigratableUrl(row.url),
			);
			results[entityType].scanned = rows.length;

			for (const { id, url } of rows) {
				// Defensive: skip anything already on Cloudflare Images.
				if (extractImageId(url)) {
					results[entityType].skipped++;
					continue;
				}
				if (dryRun) {
					results[entityType].migrated++;
					if (migrated.length < 50) {
						migrated.push({
							entityType,
							entityId: id,
							oldUrl: url,
							newUrl: "",
						});
					}
					continue;
				}
				try {
					const { id: imageId } = await importImageFromUrl(env, url, {
						metadata: { entityType, entityId: id, source: "r2-backfill" },
					});
					const newUrl = buildDeliveryUrl(env.CF_ACCOUNT_HASH, imageId);
					await updateEntityImageUrlForPlatform(context.db, {
						entityType,
						entityId: id,
						url: newUrl,
					});
					results[entityType].migrated++;
					if (migrated.length < 50) {
						migrated.push({ entityType, entityId: id, oldUrl: url, newUrl });
					}
				} catch (err) {
					results[entityType].failed++;
					if (errors.length < 50) {
						errors.push({
							entityType,
							entityId: id,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
			}
		}

		return { dryRun, results, migrated, errors };
	});

// =============================================================================
// ROUTER
// =============================================================================

export const imagesContractRouter = imagesOs.router({
	upload: uploadImageContract,
	requestUpload: requestUploadContract,
	confirmUpload: confirmUploadContract,
	delete: deleteImageContract,
	backfill: backfillContract,
});

// =============================================================================
// HELPERS
// =============================================================================

type BackfillCounts = {
	scanned: number;
	migrated: number;
	skipped: number;
	failed: number;
};

function emptyCounts(): BackfillCounts {
	return { scanned: 0, migrated: 0, skipped: 0, failed: 0 };
}

const IMAGE_AUTHORIZATION: Record<
	EntityType,
	{ permission: Permission; scope: string }
> = {
	organization: { permission: "settings:manage", scope: "apps:write" },
	app: { permission: "apps:update", scope: "apps:write" },
	tedi: { permission: "tedis:update", scope: "tedis:write" },
};

/**
 * Image writes span three RBAC resources, so a single static middleware would
 * either over-grant one entity type or deny legitimate callers for another.
 * Authorize against the entity discriminator before ownership is evaluated.
 */
export function assertEntityImageAuthorization(
	context: BaseContext,
	entityType: EntityType,
): void {
	const required = IMAGE_AUTHORIZATION[entityType];
	assertAuthorization(context, required.permission, required.scope);
}

function assertAuthorization(
	context: BaseContext,
	permission: Permission,
	requiredScope: string,
): void {
	if (context.authType === "service-binding") {
		return;
	}

	if (context.authType === "user") {
		const permitted =
			Boolean(context.user && hasPermission(context.user, permission)) ||
			Boolean(
				context.userRole &&
				roleImpliesPermission([context.userRole], permission),
			);
		if (permitted) return;
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Insufficient permissions. Required: ${permission}`,
		);
	}

	if (context.authType === "apikey") {
		const scopes = context.apiKey?.scopes ?? [];
		if (scopes.includes("platform:admin") || hasScope(scopes, requiredScope)) {
			return;
		}
	} else if (context.authType === "m2m") {
		const scopes =
			context.serviceAccount?.scope?.split(/\s+/).filter(Boolean) ?? [];
		if (scopes.includes("platform:admin") || hasScope(scopes, requiredScope)) {
			return;
		}
	} else if (
		context.authType === "tedi" &&
		context.tediScopes?.includes(requiredScope)
	) {
		return;
	}

	throw createError(ErrorCodes.FORBIDDEN, `Scope '${requiredScope}' required`);
}

/**
 * True for a URL we can migrate into Cloudflare Images: an http(s) URL that
 * isn't already on imagedelivery.net and isn't a .ico (CF Images can't ingest
 * .ico; query string tolerated).
 */
function isMigratableUrl(url: string | null): url is string {
	if (!url || !/^https?:\/\//i.test(url)) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.toLowerCase();
	if (host === "imagedelivery.net" || host.endsWith(".imagedelivery.net")) {
		return false;
	}
	if (/\.ico$/i.test(parsed.pathname)) return false;
	return true;
}

/**
 * Rows whose image column is set and migratable (legacy r2.dev assets and other
 * non-CF logos, excluding .ico). The SQL pre-filter drops already-migrated rows;
 * isMigratableUrl applies the http(s)/.ico rules in JS.
 */
async function verifyEntityOwnership(
	context: BaseContext,
	entityType: EntityType,
	entityId: string,
): Promise<void> {
	const { db, organizationId } = context;

	switch (entityType) {
		case "organization": {
			if (entityId !== organizationId) {
				throw createError(ErrorCodes.FORBIDDEN, "Organization access denied");
			}
			break;
		}
		case "app": {
			const app = await getAppById(db, entityId);
			if (!app || app.organizationId !== organizationId) {
				throw createError(ErrorCodes.FORBIDDEN, "App access denied");
			}
			break;
		}
		case "tedi": {
			const tedi = await getTediById(db, entityId);
			if (!tedi || tedi.organizationId !== organizationId) {
				throw createError(ErrorCodes.FORBIDDEN, "Tedi access denied");
			}
			break;
		}
	}
}
