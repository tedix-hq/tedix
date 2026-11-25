import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	archiveAgentSessionEventBody,
	hydrateAgentSessionEventBody,
	listAgentSessionBodiesForRetention,
	type AgentSessionEventBody,
	type AgentSessionEventBodyStore,
} from "@tedix/db/queries/agent-session-requests";
import type { DbQueryClient } from "@tedix/db/query-client";

type Owner = { organizationId: string; userId: string };
interface BodyBucket {
	put(key: string, value: ArrayBuffer): Promise<unknown>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

function prefix(owner: Owner) {
	return `agent-session-events/v1/${encodeURIComponent(owner.organizationId)}/${encodeURIComponent(owner.userId)}/`;
}

/** Uses the private TEDI_R2_BUCKET binding, placed in EU by the installation. */
export function agentSessionEventBodies(
	bucket: BodyBucket,
): AgentSessionEventBodyStore {
	return {
		async write(owner, body) {
			const bytes = new TextEncoder().encode(JSON.stringify(body));
			const key = `${prefix(owner)}${await sha256Hex(bytes)}.json.gz`;
			await bucket.put(
				key,
				await new Response(
					new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer(),
			);
			return key;
		},
		async read(owner, key) {
			if (
				!key.startsWith(prefix(owner)) ||
				!/^[a-f0-9]{64}\.json\.gz$/.test(key.slice(prefix(owner).length))
			)
				throw new Error("Invalid session event body key");
			const object = await bucket.get(key);
			if (!object) throw new Error("Session event body missing");
			const bytes = await new Response(
				new Blob([await object.arrayBuffer()])
					.stream()
					.pipeThrough(new DecompressionStream("gzip")),
			).arrayBuffer();
			if (key !== `${prefix(owner)}${await sha256Hex(bytes)}.json.gz`)
				throw new Error("Session event body digest mismatch");
			const body = JSON.parse(
				new TextDecoder().decode(bytes),
			) as AgentSessionEventBody;
			if (
				typeof body.body !== "string" ||
				(body.activity !== null && typeof body.activity !== "string")
			)
				throw new Error("Invalid session event body");
			return body;
		},
	};
}

/** Backfill processed bodies and archive reflections after 14 days, preserving rows and objects. */
export async function retainAgentSessionEventBodies(
	db: DbQueryClient,
	eventBodies: AgentSessionEventBodyStore,
	now: Date,
	// Leave headroom below D1's 1,000-query invocation limit for other retention work.
	limit = 500,
	timeBudgetMs = 60_000,
) {
	const before = new Date(now.getTime() - 14 * 86400_000).toISOString();
	const deadline = Date.now() + timeBudgetMs;
	let attempted = 0;
	let moved = 0;
	let inlineBytesMoved = 0;
	while (attempted < limit && Date.now() < deadline) {
		const rows = await listAgentSessionBodiesForRetention(
			db,
			before,
			limit - attempted,
		);
		const movedBeforePage = moved;
		for (const row of rows) {
			if (Date.now() >= deadline) return { moved, inlineBytesMoved };
			attempted++;
			const archiveReflections =
				row.processedAt !== null && row.processedAt < before;
			const body = await hydrateAgentSessionEventBody(row, {
				...row,
				eventBodies,
			});
			const key = await eventBodies.write(row, {
				body: body.body,
				activity: body.activity,
				lessonReflection: body.lessonReflection,
			});
			if (
				await archiveAgentSessionEventBody(
					db,
					row,
					key,
					now.toISOString(),
					archiveReflections,
				)
			) {
				moved++;
				inlineBytesMoved += new TextEncoder().encode(
					row.body +
						(row.activity ?? "") +
						(archiveReflections && row.lessonReflection
							? JSON.stringify(row.lessonReflection)
							: ""),
				).byteLength;
			}
		}
		// A concurrent processor may have changed every candidate in this page.
		if (moved === movedBeforePage) break;
	}
	return { moved, inlineBytesMoved };
}
