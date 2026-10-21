import { listTediRoster } from "@tedix/db/queries/tedis";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	fetchLiveTediRuntime,
	requireOrganizationId,
	requireTediAccess,
	toTediDto,
} from "./helpers";

// =============================================================================
// CRUD procedures
// =============================================================================

export const listTedis = authedTedisOs.list
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const orgId = requireOrganizationId(context);
		const {
			limit = 20,
			offset = 0,
			includeRetired = false,
			search,
			status,
		} = input || {};

		// Disjoint by design: the default view is the org's operating workers, and
		// `includeRetired` is the recovery/audit view of workers that were retired
		// (soft-deleted) with their cognitive state intact. Merging them would make
		// a retired worker look live in every list that does not read `retiredAt`.
		const { data: paged, total } = await listTediRoster(context.db, {
			organizationId: orgId,
			limit,
			offset,
			includeRetired,
			search: search?.trim(),
			status,
		});

		// Use D1-cached status columns (written by heartbeat cron) instead of
		// probing each tedi's live runtime — avoids N sequential HTTP calls that
		// timeout when containers are sleeping. Live probing is done in getTedi.
		const enriched = paged.map((t) => toTediDto(t, { env: context.env }));

		return {
			data: enriched,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

export const getTedi = authedTedisOs.get
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);

		const liveRuntime = await fetchLiveTediRuntime(tedi, context.env);

		return toTediDto(tedi, {
			env: context.env,
			liveRuntime: liveRuntime
				? {
						runtimeStatus: liveRuntime.normalizedRuntimeStatus,
						lastSeenAt: liveRuntime.lastSeenAt,
					}
				: undefined,
		});
	});

// =============================================================================
// process logs
// =============================================================================

export const getLogsProcedure = authedTedisOs.getLogs
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		await requireTediAccess(context, input.tediId);
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Container process logs have been removed. Use Agent-runtime status, runtime events, or workstation diagnostics instead.",
		);
	});
