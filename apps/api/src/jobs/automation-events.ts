/**
 * Automation-events queue consumer — the generic, tenant-agnostic dispatch
 * engine behind the `tedix-automation-events` Cloudflare Queue.
 *
 * A message IS the config (see AutomationEventSchema): it names the org, the
 * tedi, and what to dispatch — a pinned executable skill workflow or a real
 * delegated tedi turn. This module holds ZERO tenant-specific logic; a new
 * automated workflow for any tenant is a new message, not new platform code.
 *
 * Delivery semantics:
 * - Malformed/poison messages are ACKed (never retried) with a warn — a
 *   message that cannot parse today cannot parse on redelivery either.
 * - `tedi_turn` dispatch is exactly-once per `idempotencyKey` (rides the
 *   chat_dispatch_idempotency ledger inside enqueueMessage).
 * - `skill_workflow` admission is idempotent on the event's org-scoped key.
 *   Redelivery resolves to the same pinned run before the Workflow engine is
 *   invoked again. The key also remains in params for tenant-level
 *   deliverable/provider idempotency; admission dedupe does not make external
 *   effects exactly once.
 */

import { createRouterClient } from "@orpc/server";
import {
	type AutomationEvent,
	AutomationEventSchema,
} from "@tedix/api-contract/schemas/automation-events";
import { getLatestReplyDraft } from "@tedix/db/queries/work-items/reply-drafts";
import { createContext } from "../rpc/orpc";
import { skillsContractRouter } from "../rpc/routers/cognitive";
import { cognitiveRuntimeContractRouter } from "../rpc/routers/cognitive-runtime";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";

export type AutomationMessageOutcome = "ack" | "retry";

export interface AutomationEventDeps {
	/** Injectable dispatchers for unit tests. Defaults hit the real routers. */
	runSkillWorkflow?: (
		event: Extract<AutomationEvent, { kind: "skill_workflow" }>,
	) => Promise<{ status: string }>;
	enqueueTediTurn?: (
		event: Extract<AutomationEvent, { kind: "tedi_turn" }>,
	) => Promise<{ status: string }>;
	/** Whether a Work Interaction already has a reply draft. */
	hasReplyDraft?: (
		organizationId: string,
		interactionId: string,
	) => Promise<boolean>;
}

/** Canonical queue-event → skill-workflow admission mapping. */
export function buildAutomationSkillWorkflowInput(
	event: Extract<AutomationEvent, { kind: "skill_workflow" }>,
) {
	return {
		skillId: event.skillId,
		...(event.expectedSkillRevision === undefined
			? {}
			: { expectedSkillRevision: event.expectedSkillRevision }),
		slug: event.slug,
		tediId: event.tediId,
		// Top-level admission identity: runtime derives a deterministic opaque
		// run UUID from org + skill + tedi + this key. Keeping the same key in
		// params gives tenant code a separate downstream deliverable identity.
		idempotencyKey: event.idempotencyKey,
		params: {
			...event.params,
			automationIdempotencyKey: event.idempotencyKey,
		},
	};
}

function internalContext(
	env: CloudflareEnv,
	organizationId: string,
	waitUntil?: (p: Promise<unknown>) => void,
) {
	const base = createContext(
		new Request("https://api/internal/queue/automation-events"),
		env,
		waitUntil,
	);
	return buildInternalServiceBindingContext(base, organizationId);
}

/**
 * Handle one queue message body. Returns "ack" when the message is settled
 * (dispatched, or poison), "retry" on a transient dispatch failure.
 */
export async function handleAutomationEventMessage(
	env: CloudflareEnv,
	body: unknown,
	opts: { waitUntil?: (p: Promise<unknown>) => void } = {},
	deps: AutomationEventDeps = {},
): Promise<AutomationMessageOutcome> {
	const parsed = AutomationEventSchema.safeParse(body);
	if (!parsed.success) {
		console.warn(
			"[automation-events] poison message acked (schema mismatch):",
			parsed.error.issues
				.map((i) => `${i.path.join(".")}: ${i.message}`)
				.join("; "),
		);
		return "ack";
	}
	const event = parsed.data;

	try {
		if (event.kind === "skill_workflow") {
			const run =
				deps.runSkillWorkflow ??
				(async (e) => {
					const client = createRouterClient(skillsContractRouter, {
						context: internalContext(env, e.organizationId, opts.waitUntil),
					});
					return client.runWorkflow(buildAutomationSkillWorkflowInput(e));
				});
			const result = await run(event);
			console.log(
				`[automation-events] skill_workflow dispatched key=${event.idempotencyKey} status=${result.status}`,
			);
			return "ack";
		}

		if (event.skipIfReplyDraftFor) {
			const hasReplyDraft =
				deps.hasReplyDraft ??
				(async (organizationId, interactionId) =>
					(await getLatestReplyDraft(internalContext(env, organizationId).db, {
						orgId: organizationId,
						interactionId,
					})) !== null);
			if (
				await hasReplyDraft(event.organizationId, event.skipIfReplyDraftFor)
			) {
				console.log(
					`[automation-events] tedi_turn skipped key=${event.idempotencyKey}: reply already drafted`,
				);
				return "ack";
			}
		}

		const enqueue =
			deps.enqueueTediTurn ??
			(async (e) => {
				const client = createRouterClient(cognitiveRuntimeContractRouter, {
					context: internalContext(env, e.organizationId, opts.waitUntil),
				});
				return client.enqueueMessage({
					tediId: e.tediId,
					conversationId: e.conversationId,
					content: e.content,
					idempotencyKey: e.idempotencyKey,
					metadata: {
						source: e.source ?? "automation-queue",
						dispatchMode: "async",
						...(e.turnModel ? { turnModel: e.turnModel } : {}),
					},
				});
			});
		const result = await enqueue(event);
		if (result.status === "failed") {
			console.warn(
				`[automation-events] tedi_turn dispatch failed key=${event.idempotencyKey}; retrying`,
			);
			return "retry";
		}
		console.log(
			`[automation-events] tedi_turn dispatched key=${event.idempotencyKey}`,
		);
		return "ack";
	} catch (err) {
		console.warn(
			`[automation-events] dispatch threw key=${event.idempotencyKey}; retrying:`,
			err instanceof Error ? err.message : String(err),
		);
		return "retry";
	}
}

/** Structural shape of a Queues consumer batch (avoids generated-type coupling). */
export interface AutomationQueueMessage {
	body: unknown;
	ack: () => void;
	retry: () => void;
}

/**
 * Consume one batch: settle each message independently (no batch-wide retry).
 * Messages dispatch concurrently: a tedi_turn dispatch waits for the runtime
 * to admit the turn (seconds on a cold tedi), and in series a batch of delayed
 * reply-draft fallbacks started each one that much later than the last.
 */
export async function consumeAutomationEvents(
	env: CloudflareEnv,
	messages: readonly AutomationQueueMessage[],
	opts: { waitUntil?: (p: Promise<unknown>) => void } = {},
	deps: AutomationEventDeps = {},
): Promise<void> {
	await Promise.all(
		messages.map(async (message) => {
			const outcome = await handleAutomationEventMessage(
				env,
				message.body,
				opts,
				deps,
			);
			if (outcome === "ack") message.ack();
			else message.retry();
		}),
	);
}
