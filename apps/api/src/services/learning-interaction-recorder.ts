/**
 * Mechanical product-interaction learning signals.
 *
 * Product handlers call this only after their canonical mutation succeeds.
 * The learning ledger is evidence, not control flow: recording is fail-soft so
 * an analytics outage can never make an approval or retry report failure after
 * the primary action already committed.
 */

import type {
	LearningInteractionKind,
	LearningSignalClass,
} from "@tedix/api-contract/schemas/learning-feedback";
import type { DbClient } from "@tedix/db/client";
import { recordLearningInteraction } from "@tedix/db/queries/learning-feedback";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";

type LearningActor = {
	actorType: "user" | "tedi" | "service" | "api_key" | "unknown";
	actorId: string | null;
};

export function observedLearningActor(
	context: Pick<
		BaseContext,
		| "authType"
		| "user"
		| "tediId"
		| "descopeUserId"
		| "serviceAccount"
		| "apiKey"
	>,
): LearningActor {
	if (context.user?.sub) {
		return { actorType: "user", actorId: context.user.sub };
	}
	if (context.authType === "service-binding" && context.descopeUserId) {
		return { actorType: "user", actorId: context.descopeUserId };
	}
	if (context.authType === "tedi" && context.tediId) {
		return { actorType: "tedi", actorId: context.tediId };
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return { actorType: "api_key", actorId: context.apiKey.id };
	}
	if (context.authType === "service-binding" || context.authType === "m2m") {
		return {
			actorType: "service",
			actorId: context.serviceAccount?.clientId ?? null,
		};
	}
	return { actorType: "unknown", actorId: null };
}

export type ObservedLearningInteractionInput = {
	organizationId: string;
	clientEventId: string;
	signalClass?: LearningSignalClass;
	eventKind: LearningInteractionKind;
	surface: string;
	tediId?: string | null;
	issueKey?: string;
	targetType?: string;
	targetId?: string;
	threadId?: string;
	runId?: string;
	metadata?: Record<string, unknown>;
	occurredAt?: string;
};

export async function observedLearningEventId(
	prefix: string,
	...identityParts: Array<string | number | null | undefined>
): Promise<string> {
	const canonical = identityParts
		.map((part) => `${typeof part}:${String(part ?? "")}`)
		.join("\u001f");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${prefix.slice(0, 32)}:${hex}`;
}

/**
 * Record one server-observed product interaction with server-derived actor and
 * scope. Human actions learn personally; tedi actions learn on that tedi; a
 * machine action without either identity remains organization-scoped.
 */
export async function recordObservedLearningInteraction(
	context: Pick<
		BaseContext,
		| "authType"
		| "user"
		| "tediId"
		| "descopeUserId"
		| "serviceAccount"
		| "apiKey"
	> & { db: DbClient },
	input: ObservedLearningInteractionInput,
): Promise<boolean> {
	const actor = observedLearningActor(context);
	const scope =
		actor.actorType === "user" && actor.actorId
			? { kind: "personal" as const, id: actor.actorId }
			: actor.actorType === "tedi" && actor.actorId
				? { kind: "tedi" as const, id: actor.actorId }
				: { kind: "organization" as const, id: input.organizationId };

	try {
		await recordLearningInteraction(context.db, {
			organizationId: input.organizationId,
			...actor,
			tediId: input.tediId ?? context.tediId ?? null,
			clientEventId: input.clientEventId,
			signalClass: input.signalClass ?? "quality",
			eventKind: input.eventKind,
			scopeKind: scope.kind,
			scopeId: scope.id,
			issueKey: input.issueKey,
			surface: input.surface,
			targetType: input.targetType,
			targetId: input.targetId,
			threadId: input.threadId,
			runId: input.runId,
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			occurredAt: input.occurredAt ?? new Date().toISOString(),
		});
		return true;
	} catch (error) {
		console.warn("[learning-feedback] product interaction stamp failed", {
			clientEventId: input.clientEventId,
			eventKind: input.eventKind,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
