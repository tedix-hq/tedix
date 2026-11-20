/**
 * Gives a tedi a reflection turn for each of its chats with a person that
 * has gone quiet. Runs every ten minutes; see `services/tedi-memory-reflection`.
 */

import { createDbClient, type DbClient } from "@tedix/db/client";
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

export function dispatchTediMemoryReflection(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	return reflectOnQuietConversations({
		db: createDbClient(env.DB),
		env,
		send: (request) => env.TEDI_SERVICE.fetch(request),
		now: Math.max(scheduledTime, Date.now()),
	});
}
