/**
 * `completion/complete` provider for the aggregate / kernel MCP surface.
 *
 * 2026-07-28 autocomplete (transport.ts `completionHandler`). Serves argument
 * suggestions for kernel→tedi composition: when an agent (kernel or another
 * tedi) is filling in a tedi-targeting argument — `tediId`, `slug`,
 * `session_key`, `namespace`, `conversationId` — it asks `completion/complete`
 * and we answer from data the aggregate already has in hand:
 *
 *  - the aggregate's known tedis (`mcpConfig.aggregateTedis`, hydrated with the
 *    D1 tediId), which the surface already resolved to build the `tedi:*` tools;
 *  - the caller org's Home conversations (a single bounded
 *    `kernelRuntime/listConversations` read) for conversation/session ids.
 *
 * Bounded + fast: the tedi candidates are already in memory (no fan-out), and
 * the conversation read is one capped RPC fetched only for conversation-shaped
 * arguments and only when an org is known. Everything is filtered by the
 * argument's partial value and capped well under the 100-value spec limit.
 */

import type {
	McpCompletionRequest,
	McpCompletionResult,
} from "@tedix/mcp-shared/transport";
import { callApiRpc } from "../lib/rpc";
import type { AggregateTediEntry } from "./aggregate-tedis";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** Hard cap we return; the transport also caps at 100. Keep it tight. */
const MAX_COMPLETION_VALUES = 50;
/** Bounded conversation read — never fan out further than this. */
const CONVERSATION_FETCH_LIMIT = 50;
const CONVERSATION_RPC_TIMEOUT_MS = 4_000;

/** Argument names that target a tedi by slug. */
const SLUG_ARG_NAMES = new Set(["slug", "tedislug", "tedi_slug", "namespace"]);
/** Argument names that target a tedi by id. */
const TEDI_ID_ARG_NAMES = new Set(["tediid", "tedi_id"]);
/** Argument names that target a conversation/session. */
const CONVERSATION_ARG_NAMES = new Set([
	"conversationid",
	"conversation_id",
	"session_key",
	"sessionkey",
]);

/** Case-insensitive prefix-then-substring filter, de-duplicated, capped. */
function filterCandidates(values: string[], partial: string): string[] {
	const needle = partial.trim().toLowerCase();
	const seen = new Set<string>();
	const prefix: string[] = [];
	const substring: string[] = [];
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		if (!needle) {
			prefix.push(value);
			continue;
		}
		const lower = value.toLowerCase();
		if (lower.startsWith(needle)) prefix.push(value);
		else if (lower.includes(needle)) substring.push(value);
	}
	return [...prefix, ...substring].slice(0, MAX_COMPLETION_VALUES);
}

export interface AggregateCompletionDeps {
	/** Tedis the aggregate already resolved (hydrated with D1 tediId). */
	aggregateTedis: AggregateTediEntry[];
	/** Caller org for conversation reads; omit to skip the conversation fetch. */
	organizationId?: string;
	env: CloudflareEnv;
}

/** Collect slug/namespace candidates from the resolved aggregate tedis. */
function tediSlugCandidates(tedis: AggregateTediEntry[]): string[] {
	const out: string[] = [];
	for (const tedi of tedis) {
		if (tedi.namespace) out.push(tedi.namespace);
		if (tedi.slug) out.push(tedi.slug);
	}
	return out;
}

/** Collect tediId candidates (only the D1-hydrated ones). */
function tediIdCandidates(tedis: AggregateTediEntry[]): string[] {
	return tedis
		.map((tedi) => tedi.tediId)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Static session-key candidates from the aggregate tedis (e.g. `agent:main:main`). */
function tediSessionCandidates(tedis: AggregateTediEntry[]): string[] {
	return tedis
		.map((tedi) => tedi.sessionKey)
		.filter((key): key is string => typeof key === "string" && key.length > 0);
}

/**
 * One bounded `kernelRuntime/listConversations` read for the caller org. Returns
 * conversation ids (best effort) — any failure yields an empty list so
 * completion never blocks or throws.
 */
async function fetchConversationIds(
	env: CloudflareEnv,
	organizationId: string,
	search: string,
): Promise<string[]> {
	if (!env.API_SERVICE && !env.API_URL) return [];
	try {
		const { data, status } = await callApiRpc(
			env,
			"kernelRuntime/listConversations",
			{
				limit: CONVERSATION_FETCH_LIMIT,
				...(search.trim() ? { search: search.trim() } : {}),
			},
			{
				headers: { "X-Tedix-Org-Id": organizationId },
				timeoutMs: CONVERSATION_RPC_TIMEOUT_MS,
			},
		);
		if (status >= 400) return [];
		const rows = isRecord(data)
			? Array.isArray(data.conversations)
				? data.conversations
				: Array.isArray(data.data)
					? data.data
					: []
			: [];
		const ids: string[] = [];
		for (const row of rows) {
			if (!isRecord(row)) continue;
			const id = row.id ?? row.conversationId ?? row.sessionKey;
			if (typeof id === "string" && id) ids.push(id);
		}
		return ids;
	} catch {
		return [];
	}
}

/**
 * Build the aggregate-surface completion handler. Resolves tedi-targeting and
 * conversation/session arguments from already-resolved aggregate data plus one
 * bounded conversation read. Unknown argument names return no suggestions.
 */
export function buildAggregateCompletionHandler(
	deps: AggregateCompletionDeps,
): (
	request: McpCompletionRequest,
) => Promise<McpCompletionResult> | McpCompletionResult {
	const { aggregateTedis, organizationId, env } = deps;

	return async ({ argument }) => {
		const argName = argument.name.trim().toLowerCase();
		const partial = argument.value ?? "";

		if (SLUG_ARG_NAMES.has(argName)) {
			return {
				values: filterCandidates(tediSlugCandidates(aggregateTedis), partial),
			};
		}

		if (TEDI_ID_ARG_NAMES.has(argName)) {
			return {
				values: filterCandidates(tediIdCandidates(aggregateTedis), partial),
			};
		}

		if (CONVERSATION_ARG_NAMES.has(argName)) {
			// Static session keys are always cheap; only spend the bounded
			// conversation read when an org is in context.
			const sessionCandidates = tediSessionCandidates(aggregateTedis);
			const conversationIds = organizationId
				? await fetchConversationIds(env, organizationId, partial)
				: [];
			return {
				values: filterCandidates(
					[...sessionCandidates, ...conversationIds],
					partial,
				),
			};
		}

		return { values: [] };
	};
}

/**
 * SEP-2640: `completion/complete` provider for the skill:// resource-
 * template variables `skill_name` and `app_slug`
 * (`skill://{skill_name}/SKILL.md`, `skill://{app_slug}/{skill_name}/SKILL.md`),
 * built from the skill catalog registered on a skill-serving surface so hosts
 * can autocomplete a skill before reading the resolved resource. Returns `null`
 * for arguments it does not own, so a merged completer can fall through to the
 * kernel/aggregate handler.
 */
export function buildSkillCompletionHandler(deps: {
	skillNames: string[];
	appSlugs: string[];
}): (input: McpCompletionRequest) => McpCompletionResult | null {
	const skillNames = [...new Set(deps.skillNames)].sort();
	const appSlugs = [...new Set(deps.appSlugs)].sort();
	return ({ argument }) => {
		const argName = argument.name.trim().toLowerCase();
		const partial = argument.value ?? "";
		if (argName === "skill_name") {
			return { values: filterCandidates(skillNames, partial) };
		}
		if (argName === "app_slug") {
			return { values: filterCandidates(appSlugs, partial) };
		}
		return null;
	};
}
