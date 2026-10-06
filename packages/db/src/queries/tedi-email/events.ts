/**
 * Tedi Email Query Helpers
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediEmailEvents } from "../../schema/tedi-email";

export async function recordTediEmailEvent(
	db: DbClient,
	input: {
		tediId: string;
		organizationId: string;
		threadId?: string | null;
		messageId?: string | null;
		eventType: string;
		provider?: string | null;
		payload?: Record<string, JsonValue> | null;
	},
): Promise<void> {
	await db.insert(tediEmailEvents).values({
		id: crypto.randomUUID(),
		tediId: input.tediId,
		organizationId: input.organizationId,
		threadId: input.threadId ?? null,
		messageId: input.messageId ?? null,
		eventType: input.eventType,
		provider: input.provider ?? null,
		payload: input.payload ?? {},
	});
}

type EmailMessageIdentity = {
	id: string;
	threadId: string;
	tediId: string;
	organizationId: string;
};

export type TediEmailOutcomeInput =
	| {
			kind: "worker_dispatch";
			message: EmailMessageIdentity;
			result: "sdk_returned" | "no_route" | "skipped" | "failed" | "unknown";
			elapsedMs: number;
	  }
	| {
			kind: "runtime_turn";
			message: EmailMessageIdentity;
			runId: string;
			result: "completed" | "failed" | "unknown";
			elapsedMs: number;
			replied: boolean | null;
	  };

/** One immutable outcome per message/phase (and runtime run), safe on retry. */
export async function recordTediEmailOutcome(
	db: DbClient,
	input: TediEmailOutcomeInput,
): Promise<{ id: string; duplicate: boolean }> {
	const eventType =
		input.kind === "worker_dispatch"
			? "worker_dispatch_outcome"
			: "runtime_turn_outcome";
	const key = JSON.stringify([
		"tedi-email-outcome-v1",
		eventType,
		input.message.id,
		input.kind === "runtime_turn" ? input.runId : null,
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key),
	);
	const id = `email-outcome:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
	const payload: Record<string, JsonValue> = {
		runId: input.kind === "runtime_turn" ? input.runId : null,
		elapsedMs: input.elapsedMs,
		result: input.result,
		replied: input.kind === "runtime_turn" ? input.replied : null,
	};
	const provider =
		input.kind === "worker_dispatch" ? "email-ingress" : "tedi-runtime";
	const inserted = await db
		.insert(tediEmailEvents)
		.values({
			id,
			messageId: input.message.id,
			threadId: input.message.threadId,
			tediId: input.message.tediId,
			organizationId: input.message.organizationId,
			eventType,
			provider,
			payload,
		})
		.onConflictDoNothing()
		.returning({ id: tediEmailEvents.id });
	if (inserted.length > 0) return { id, duplicate: false };

	const existing = await db
		.select({
			messageId: tediEmailEvents.messageId,
			threadId: tediEmailEvents.threadId,
			tediId: tediEmailEvents.tediId,
			organizationId: tediEmailEvents.organizationId,
			eventType: tediEmailEvents.eventType,
			provider: tediEmailEvents.provider,
			payload: tediEmailEvents.payload,
		})
		.from(tediEmailEvents)
		.where(eq(tediEmailEvents.id, id))
		.limit(1);
	const previous = existing[0];
	if (
		!previous ||
		previous.messageId !== input.message.id ||
		previous.threadId !== input.message.threadId ||
		previous.tediId !== input.message.tediId ||
		previous.organizationId !== input.message.organizationId ||
		previous.eventType !== eventType ||
		previous.provider !== provider ||
		JSON.stringify(previous.payload) !== JSON.stringify(payload)
	) {
		throw new Error("Conflicting email outcome observation");
	}
	return { id, duplicate: true };
}
