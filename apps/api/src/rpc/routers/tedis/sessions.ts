/**
 * Tedis Router — OS session organization state
 */

import {
	bulkSoftDeleteTediSessionStates,
	listTediConversationActivity,
	listTediSessionStates,
	upsertTediSessionState,
} from "@tedix/db/queries/tedi-sessions";
import {
	AUTHZ,
	authedTedisOs,
	type BaseContext,
	createError,
	ErrorCodes,
	requireOrganizationId,
	requireTediAccess,
} from "./helpers";

function sessionActorId(context: BaseContext): string {
	if (context.user?.sub) return `user:${context.user.sub}`;
	if (context.descopeUserId) return `tedi-user:${context.descopeUserId}`;
	if (context.apiKey?.id) return `api-key:${context.apiKey.id}`;
	if (context.serviceAccount?.clientId) {
		return `service:${context.serviceAccount.clientId}`;
	}
	throw createError(ErrorCodes.UNAUTHORIZED, "Authenticated user required");
}

function isMissingSessionStateTable(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("no such table: tedi_session_states");
}

export async function deleteRuntimeSessionForTedi(_input: unknown): Promise<{
	deleted?: boolean;
	retainedTranscripts?: string[];
}> {
	return { deleted: false, retainedTranscripts: [] };
}

export const listSessionStatesProcedure = authedTedisOs.listSessionStates
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const organizationId = requireOrganizationId(context);
		const userId = sessionActorId(context);

		try {
			const states = await listTediSessionStates(context.db, {
				organizationId,
				tediId: tedi.id,
				userId,
			});
			return { states };
		} catch (error) {
			if (isMissingSessionStateTable(error)) {
				console.warn(
					"[Tedis] Session state table is not migrated yet; returning empty state list.",
				);
				return { states: [] };
			}
			throw error;
		}
	});

export const updateSessionStateProcedure = authedTedisOs.updateSessionState
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const organizationId = requireOrganizationId(context);
		const userId = sessionActorId(context);

		try {
			const state = await upsertTediSessionState(context.db, {
				organizationId,
				tediId: tedi.id,
				userId,
				sessionKey: input.sessionKey,
				title: input.title,
				derivedTitle: input.derivedTitle,
				pinned: input.pinned,
				deleted: input.deleted,
				lastSeenAt: input.lastSeenAt,
			});
			if (!state) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Failed to save session state",
				);
			}
			return state;
		} catch (error) {
			if (isMissingSessionStateTable(error)) {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Session actions are still being enabled. Try again shortly.",
				);
			}
			throw error;
		}
	});

export const deleteSessionProcedure = authedTedisOs.deleteSession
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const organizationId = requireOrganizationId(context);
		const userId = sessionActorId(context);
		const runtimeResult = await deleteRuntimeSessionForTedi({
			env: context.env,
			sessionKey: input.sessionKey,
			tedi,
		});

		try {
			const state = await upsertTediSessionState(context.db, {
				organizationId,
				tediId: tedi.id,
				userId,
				sessionKey: input.sessionKey,
				deleted: true,
				pinned: false,
			});
			if (!state) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Failed to save session state",
				);
			}
		} catch (error) {
			if (isMissingSessionStateTable(error)) {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Session actions are still being enabled. Try again shortly.",
				);
			}
			throw error;
		}

		return {
			success: true,
			sessionKey: input.sessionKey,
			runtimeDeleted: runtimeResult.deleted,
			retainedTranscripts: runtimeResult.retainedTranscripts,
		};
	});

/** Hard guard — the canonical default session is never bulk-deletable. */
const MAIN_SESSION_RE = /(^|:)agent:main:main$/;
/** Refuse to soft-delete more than this many sessions in one call. */
const BULK_DELETE_CAP = 500;

/**
 * Pure selection for {@link deleteSessionsProcedure}: an explicit `sessionKeys`
 * list wins (deduped); otherwise filter the enumerated `conversations` by a
 * pre-compiled id `pattern` and/or an ISO `cutoffIso` (last activity strictly
 * older than the cutoff). The canonical `agent:main:main` session is ALWAYS
 * removed from the result, even if explicitly listed or matched.
 */
export function selectBulkDeleteTargets(input: {
	sessionKeys?: string[];
	conversations: Array<{ id: string; lastActivityIso: string | null }>;
	pattern: RegExp | null;
	cutoffIso: string | null;
}): string[] {
	let matched: string[];
	if (input.sessionKeys && input.sessionKeys.length > 0) {
		matched = [...new Set(input.sessionKeys)];
	} else {
		matched = input.conversations
			.filter((c) => typeof c.id === "string" && c.id.length > 0)
			.filter((c) => (input.pattern ? input.pattern.test(c.id) : true))
			.filter((c) =>
				input.cutoffIso ? (c.lastActivityIso ?? "") < input.cutoffIso : true,
			)
			.map((c) => c.id);
	}
	return matched.filter((sk) => !MAIN_SESSION_RE.test(sk));
}

export const deleteSessionsProcedure = authedTedisOs.deleteSessions
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const organizationId = requireOrganizationId(context);
		const userId = sessionActorId(context);

		// Resolve the target session keys: an explicit list wins; otherwise
		// enumerate the tedi's conversations from the ledger and filter by
		// id-pattern and/or age. The org filter keeps this strictly in-tenant.
		let pattern: RegExp | null = null;
		if (input.idPattern) {
			try {
				pattern = new RegExp(input.idPattern, "i");
			} catch {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"idPattern is not a valid regular expression",
				);
			}
		}
		const cutoffIso = input.olderThanDays
			? new Date(Date.now() - input.olderThanDays * 86_400_000).toISOString()
			: null;
		const usingExplicitList = !!(
			input.sessionKeys && input.sessionKeys.length > 0
		);
		let conversations: Array<{ id: string; lastActivityIso: string | null }> =
			[];
		if (!usingExplicitList) {
			conversations = await listTediConversationActivity(context.db, {
				organizationId,
				tediId: tedi.id,
			});
		}
		const matched = selectBulkDeleteTargets({
			sessionKeys: input.sessionKeys,
			conversations,
			pattern,
			cutoffIso,
		});

		if (matched.length > BULK_DELETE_CAP) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Refusing to bulk-delete ${matched.length} sessions in one call (cap ${BULK_DELETE_CAP}). Narrow the filter or pass an explicit sessionKeys batch.`,
			);
		}

		if (input.dryRun) {
			return { matched, deleted: 0, dryRun: true };
		}

		// Bulk path is marker-only and BATCHED: write the soft-delete markers in
		// multi-row upserts (one query per chunk) instead of N sequential
		// round-trips — a >~90 synchronous loop previously timed the request out.
		// The per-session runtime-session clear that single `deleteSession` does is
		// intentionally skipped here: it is a no-op for isolate tedis, and the
		// `deletedAt` marker (not the runtime session) is the source of truth for
		// the conversation list; a stale container gateway session simply sleeps.
		let deleted = 0;
		try {
			deleted = await bulkSoftDeleteTediSessionStates(context.db, {
				organizationId,
				tediId: tedi.id,
				userId,
				sessionKeys: matched,
			});
		} catch (error) {
			if (isMissingSessionStateTable(error)) {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Session actions are still being enabled. Try again shortly.",
				);
			}
			throw error;
		}

		return { matched, deleted, dryRun: false };
	});
