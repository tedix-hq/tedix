/**
 * Compaction-triggered memory reflection.
 *
 * WHY: reflection was purely TIME-triggered — `runMemoryReflection`
 * sweeps every org at 4am UTC with `scope: "full"`. That sweep has no idea what
 * was lost. The runtime's session-compaction seam emits ONE canonical
 * `context.compacted` runtime event per real cut into D1 `tedi_runtime_events`.
 * This durable signal identifies a conversation whose replay context changed.
 *
 * So the signal exists, it is durable, and nothing consumed it. This closes that
 * loop: reflect on the conversation that just dropped context, scoped to that
 * tedi, instead of waiting for a nightly org-wide pass.
 *
 * Prior art: a comparable coding agent's `ReflectionTriggerMode` is
 * `"off" | "step-count" | "compaction-event"` — compaction is a first-class
 * reflection trigger there for exactly this reason.
 *
 * EXACTLY-ONCE: the compaction event id already embeds `runId` +
 * `firstKeptEntryId` (idempotent for a retried cut at the same boundary), so
 * deriving the Workflow instance id from it makes a duplicated ledger write
 * collapse onto the same instance. Cloudflare Workflows rejects a duplicate
 * instance id, which is the enforcement — not a best-effort dedup table.
 */

/** The ledger event kind emitted once per real session compaction cut. */
export const COMPACTION_EVENT_KIND = "context.compacted";

/** Instance-id prefix; keeps compaction reflections greppable in `wrangler workflows`. */
const INSTANCE_PREFIX = "reflect-compaction-";

/** Cloudflare Workflow instance ids reject colons (same constraint as `buildWorkflowInstanceId`). */
const UNSAFE_INSTANCE_CHARS = /[^a-zA-Z0-9_-]/g;

/** Cloudflare caps instance ids; leave headroom for the prefix. */
const MAX_INSTANCE_ID_LENGTH = 100;

/** Hex length of the appended digest when an id must be shortened. */
const DIGEST_LENGTH = 12;

export function isCompactionEventKind(kind: string): boolean {
	return kind === COMPACTION_EVENT_KIND;
}

/**
 * FNV-1a over the FULL event id. Not cryptographic — it only has to keep two
 * distinct cuts from colliding after truncation.
 */
function digest(value: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
	}
	return (
		h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
	).slice(0, DIGEST_LENGTH);
}

/**
 * Deterministic Workflow instance id for one compaction cut. Same event id →
 * same instance id → the second create collapses instead of double-reflecting.
 *
 * Production compaction event ids run ~160 chars — the emitter appends the full
 * session key and cron fire key after the marker timestamp
 * (`{tediId}:compaction:{markerTs}:compaction:agent:main:main:{tediId}:cron:{fireKey}:0`).
 * A plain `slice()` would cut the distinguishing tail off, so two different cuts could collapse onto one instance id and the
 * second reflection would be silently skipped as a duplicate. Truncation
 * therefore preserves a readable head AND appends a digest of the whole id.
 */
export function buildCompactionReflectionInstanceId(eventId: string): string {
	const sanitized = eventId.replace(UNSAFE_INSTANCE_CHARS, "-");
	const full = `${INSTANCE_PREFIX}${sanitized}`;
	if (full.length <= MAX_INSTANCE_ID_LENGTH) return full;
	const head = full.slice(0, MAX_INSTANCE_ID_LENGTH - DIGEST_LENGTH - 1);
	return `${head}-${digest(sanitized)}`;
}

/** A duplicate instance id is the SUCCESS case: another cut already reflected. */
export function isDuplicateInstanceError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /already exists|duplicate|instance.*exists/i.test(message);
}

export interface CompactionReflectionWorkflowBinding {
	create(options: {
		id: string;
		params: {
			organizationId: string;
			tediId?: string;
			scope: "full" | "recent" | "domain";
		};
	}): Promise<{ id: string }>;
}

export interface StartCompactionReflectionInput {
	workflow: CompactionReflectionWorkflowBinding | undefined;
	eventId: string;
	organizationId: string;
	tediId: string;
}

export type CompactionReflectionOutcome =
	| { status: "started"; instanceId: string }
	| { status: "duplicate"; instanceId: string }
	| { status: "skipped"; reason: "no_binding" }
	| { status: "failed"; reason: string };

/**
 * Start a SCOPED reflection for the compacting tedi.
 *
 * `scope: "recent"` deliberately, not `"full"`: the nightly sweep owns the
 * expensive whole-org pass (500 facts, graph algorithms, capability
 * distillation). This is the cheap targeted pass at the moment of loss, and a
 * compacting fleet must not be able to trigger N full org reflections an hour.
 *
 * Never throws — reflection is a learning signal, and a reflection outage must
 * not fail the ledger write that carries the compaction record itself.
 */
export async function startCompactionReflection(
	input: StartCompactionReflectionInput,
): Promise<CompactionReflectionOutcome> {
	if (!input.workflow) return { status: "skipped", reason: "no_binding" };
	const instanceId = buildCompactionReflectionInstanceId(input.eventId);
	try {
		await input.workflow.create({
			id: instanceId,
			params: {
				organizationId: input.organizationId,
				tediId: input.tediId,
				scope: "recent",
			},
		});
		return { status: "started", instanceId };
	} catch (error) {
		if (isDuplicateInstanceError(error)) {
			return { status: "duplicate", instanceId };
		}
		return {
			status: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
