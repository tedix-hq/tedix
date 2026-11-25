/**
 * Gives a tedi a reflection turn for each of its chats with a person that
 * has gone quiet. Runs every ten minutes, including organization enrichment
 * at 04:10 UTC; see `services/tedi-memory-reflection`.
 */

import { coreDb } from "@tedix/db/core-store/scope";
import { type DbClient } from "@tedix/db/client";
import { listTediRuntimeEventsForRouter } from "@tedix/db/queries/cognitive-runtime";
import { listRecentlyActiveTedis } from "@tedix/db/queries/tedi-memory";
import type { TediHostEnv } from "../lib/platform-hosts";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import {
	deliverMemoryReflection,
	memoryReflectionEnabled,
	quietConversations,
	REFLECTION_LOOKBACK_MS,
	reflectionText,
} from "../services/tedi-memory-reflection";

const TEDIS_PER_TICK = 40;
const EVENTS_PER_TEDI = 80;
const RUN_BUDGET_MS = 30_000;

export async function reflectOnQuietConversations(input: {
	db: DbClient;
	env: TediHostEnv;
	send: (request: Request) => Promise<Response>;
	now: number;
}): Promise<Record<string, number>> {
	const { db, now } = input;
	const deadline = Date.now() + RUN_BUDGET_MS;
	const counts = { tedis: 0, off: 0, turns: 0, deduplicated: 0, failed: 0 };
	const tedis = await listRecentlyActiveTedis(db, {
		since: new Date(now - REFLECTION_LOOKBACK_MS).toISOString(),
		limit: TEDIS_PER_TICK,
	});
	counts.tedis = tedis.length;
	for (const tedi of tedis) {
		if (Date.now() >= deadline) break;
		if (!memoryReflectionEnabled(tedi.runtimeOverrides)) {
			counts.off++;
			continue;
		}
		try {
			const events = await listTediRuntimeEventsForRouter(db, {
				organizationId: tedi.orgId,
				tediId: tedi.tediId,
				kinds: ["message.received", "message.completed"],
				// Older messages cannot make a chat quiet-but-recent; without the
				// bound the read walked ~12k of the tedi's events per call.
				since: new Date(now - REFLECTION_LOOKBACK_MS).toISOString(),
				order: "desc",
				limit: EVENTS_PER_TEDI,
			});
			for (const conversation of quietConversations(events, tedi.slug, now)) {
				const receipt = await deliverMemoryReflection({
					...input,
					...tedi,
					subject: `conversation:${conversation.conversationId}:${conversation.lastMessageAt}`,
					text: reflectionText("conversation", conversation.messages),
				});
				if (receipt.deduplicated) counts.deduplicated++;
				else counts.turns++;
			}
		} catch (error) {
			counts.failed++;
			console.warn("[tedi-memory-reflection] reflection failed", {
				tediId: tedi.tediId,
				exception: safeExceptionTopology(error),
			});
		}
	}
	return counts;
}

export async function dispatchTediMemoryReflection(
	env: CloudflareEnv,
	scheduledTime: number,
	runId: string,
): Promise<Record<string, number>> {
	const { fleetAuthorityIsEnabled } = await import("../lib/fleet-authority");
	const { PlatformCronPathError } = await import("./platform-cron-receipts");
	const counts: Record<string, number> = {};
	const errors: unknown[] = [];
	if (env.TEDI_SERVICE) {
		try {
			Object.assign(
				counts,
				await reflectOnQuietConversations({
					db: coreDb(env),
					env,
					send: (request) => env.TEDI_SERVICE.fetch(request),
					now: Math.max(scheduledTime, Date.now()),
				}),
			);
		} catch (error) {
			counts.conversationReflectionFailed = 1;
			errors.push(error);
		}
	}
	const at = new Date(scheduledTime);
	if (
		fleetAuthorityIsEnabled(env) &&
		at.getUTCHours() === 4 &&
		at.getUTCMinutes() === 10
	) {
		try {
			Object.assign(counts, await enrichMemory(env, runId));
		} catch (error) {
			counts.memoryEnrichmentFailed = 1;
			errors.push(error);
		}
	}
	if (errors.length)
		throw new PlatformCronPathError(
			errors,
			"Memory maintenance failed",
			counts,
		);
	return counts;
}

const CITATION_BACKFILL_BUDGET = 2000;

async function enrichMemory(
	env: CloudflareEnv,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Starting MemoryReflectionWorkflow (${runId})`);
	const { listOrganizations } = await import("@tedix/db/queries/organizations");
	const { backfillFactSearch } =
		await import("@tedix/db/queries/memory-graph/hybrid-recall");
	const { backfillFactCitations } =
		await import("@tedix/db/queries/memory-graph/fact-citations");
	const db = coreDb(env);

	const orgs = await listOrganizations(db);
	let searchRowsBackfilled = 0;
	let citationFactsBackfilled = 0;
	for (const org of orgs) {
		try {
			searchRowsBackfilled += await backfillFactSearch(db, {
				organizationId: org.id,
			});
		} catch (error) {
			console.warn("[Scheduled] Memory search backfill unavailable", {
				orgId: org.id,
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		try {
			// Drain each org in resumable 100-fact pages; recall skips the legacy
			// fallback once an org's marker is done, so finish within days, not years.
			while (citationFactsBackfilled < CITATION_BACKFILL_BUDGET) {
				const page = await backfillFactCitations(
					db,
					{ organizationId: org.id },
					CITATION_BACKFILL_BUDGET - citationFactsBackfilled,
				);
				citationFactsBackfilled += page;
				if (page < 100) break;
			}
		} catch (error) {
			console.warn("[Scheduled] Memory citation backfill unavailable", {
				orgId: org.id,
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		const instance = await env.MEMORY_REFLECTION_WORKFLOW.create({
			id: `reflection-${org.id}-${runId}`,
			params: {
				organizationId: org.id,
				scope: "full" as const,
			},
		});
		console.log(
			`[Scheduled] MemoryReflectionWorkflow started for org ${org.id}: ${instance.id}`,
		);
	}

	return {
		searchRowsBackfilled,
		citationFactsBackfilled,
		organizationsDispatched: orgs.length,
		workflowsDispatched: orgs.length,
	};
}
