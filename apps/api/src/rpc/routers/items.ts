/**
 * Items oRPC Router
 * REST-compatible endpoints for item CRUD operations
 *
 * This router uses contract-first development with oRPC.
 * The contract is imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import {
	type ItemResponse,
	itemsContract,
} from "@tedix/api-contract/contracts/items";
import type { DbClient } from "@tedix/db/client";
import {
	deleteItem,
	deleteItemsByApp,
	getItemById,
	getItemCount,
	getItemsByApp,
	searchItems,
	upsertItems,
} from "@tedix/db/queries/items";
import { getAppById } from "@tedix/db/queries/app-records";
import type { NewItem } from "@tedix/db/schema/items";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const itemsOs = implement(itemsContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all items endpoints require authentication
 */
const authedItemsOs = itemsOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

async function requireAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based list procedure implementation
 */
export const listItems = authedItemsOs.list
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, limit, offset } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);
		const items = await getItemsByApp(db, appId, { limit, offset });
		const total = await getItemCount(db, appId);

		return {
			data: items as ItemResponse[],
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Contract-based get procedure implementation
 */
export const getItem = authedItemsOs.get
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, itemId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const item = await getItemById(db, itemId);
		if (!item) {
			throw createError(ErrorCodes.NOT_FOUND, "Item not found");
		}

		// Verify item belongs to the requested app
		if (item.appId !== appId) {
			throw createError(ErrorCodes.NOT_FOUND, "Item not found in this app");
		}

		return {
			data: item as ItemResponse,
		};
	});

/**
 * Contract-based search procedure implementation
 */
export const searchItemsProcedure = authedItemsOs.search
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, q, limit } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);
		const items = await searchItems(db, appId, q, { limit });

		return {
			data: items as ItemResponse[],
			query: q,
			pagination: {
				limit,
				offset: 0,
				total: items.length,
				hasMore: false,
			},
		};
	});

/**
 * Contract-based create/upsert procedure implementation
 */
export const createItemsProcedure = authedItemsOs.create
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, items } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		// Transform API format (camelCase) to database format
		const transformedItems = items.map((item: (typeof items)[number]) => ({
			id: item.id,
			externalId: item.externalId,
			vertical: item.vertical,
			title: item.title,
			description: item.description,
			image: item.imageUrl,
			priceAmount: item.price,
			priceCurrency: item.currency || "EUR",
			url: item.url,
			metadata: item.metadata ?? null,
		}));

		const result = await upsertItems(db, appId, transformedItems as NewItem[]);

		return {
			data: result,
		};
	});

/**
 * Contract-based delete all items procedure implementation
 */
export const deleteAllItemsProcedure = authedItemsOs.deleteAll
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);
		const count = await deleteItemsByApp(db, appId);

		return {
			message: `Deleted ${count} items`,
			count,
		};
	});

/**
 * Contract-based delete item procedure implementation
 */
export const deleteItemProcedure = authedItemsOs.delete
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, itemId } = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		const item = await getItemById(db, itemId);
		if (!item) {
			throw createError(ErrorCodes.NOT_FOUND, "Item not found");
		}

		// Verify item belongs to the requested app
		if (item.appId !== appId) {
			throw createError(ErrorCodes.NOT_FOUND, "Item not found in this app");
		}

		const deleted = await deleteItem(db, itemId);
		if (!deleted) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Item not found or already deleted",
			);
		}

		return {
			message: "Item deleted successfully",
			deletedId: itemId,
		};
	});

/**
 * Contract-based import procedure implementation
 *
 * Starts a Cloudflare Workflow for durable item import processing.
 * The workflow handles:
 * 1. Extract items array from data using arrayKey
 * 2. Normalize items (field mapping, SKU generation, image normalization)
 * 3. Convert to DB format with toItemInsert()
 * 4. Upsert to database (idempotent via externalId)
 * 5. Generate quality report
 *
 * Auth: Requires apps:write scope and app ownership
 * Rate limit: Max 500 items per request
 */
export const importItemsProcedure = authedItemsOs.import
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const {
			appId,
			data,
			arrayKey,
			vertical,
			sourceUrl,
			fieldMappings,
			limit,
			dryRun,
		} = input;

		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);

		// Start import workflow with all parameters
		const workflow = await env.IMPORT_WORKFLOW.create({
			params: {
				appId,
				data,
				arrayKey,
				vertical,
				sourceUrl,
				fieldMappings,
				limit,
				dryRun,
			},
		});

		return {
			workflowId: workflow.id,
			message:
				"Import workflow started. Check status with /workflows/{workflowId}/status",
			status: "queued" as const,
		};
	});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const itemsContractRouter = authedItemsOs.router({
	list: skipOutputValidation(listItems),
	get: skipOutputValidation(getItem),
	search: skipOutputValidation(searchItemsProcedure),
	create: createItemsProcedure,
	deleteAll: deleteAllItemsProcedure,
	delete: deleteItemProcedure,
	import: importItemsProcedure,
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================
