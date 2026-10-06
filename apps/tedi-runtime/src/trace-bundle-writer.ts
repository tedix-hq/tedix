/**
 * Raw trace-bundle writer for the isolate tedi runtime.
 *
 * Writes the redacted `harness/runs/<runId>/...` evidence folder
 * (`docs/cognition/harness.md` § Trace Bundle Shape) to R2 and returns its `bundleUri`,
 * which the per-run `TraceBundle` row references. Every file passes through the
 * FAIL-CLOSED `@tedix/context-core/trace-safety` redactor before it is written —
 * raw prompts / outputs / payloads are NEVER committed unredacted (the trace
 * safety contract). The bundle row itself still holds only ids + the uri; this
 * adds the replayable-evidence layer the ids point at.
 *
 * Evidence captured here is what the post-turn bridge path has in hand:
 * manifest, the assembled prompt (system + user), the model output, the injected
 * directives, the per-turn tool-call telemetry, the retrieved brain facts
 * (`memory-hits.jsonl`, from the prompt-injected brain digest), the disclosed
 * skill/guidance summaries (`skills.jsonl`, from the MCP runtime guidance block),
 * and the outcome. This closes the `memory-hits.jsonl` / `skills.jsonl` learning
 * substrate the `docs/cognition/harness.md` Trace Bundle Shape lists. On the
 * recovery-exhaustion evidence path a `recovery.json`
 * file is added carrying the incident identity + give-up reason/budget + linkage
 * ids, turning SDK recovery telemetry into harness-certification evidence. Every
 * conditional file is written only when present and omitted otherwise, so the
 * bundle grows without a shape change (additive, back-compatible). Richer
 * per-step tool capture remains the documented follow-up (140c — subscribe the
 * Agents SDK `diagnostics_channel` and map its `requestId` to this stable
 * `runId`).
 *
 * Fail-soft on R2 I/O (a write error must never break chat); fail-CLOSED on
 * redaction (a redaction error yields a marker file, never raw content).
 */

import { logTediPersistenceFailure } from "./persistence-failure-log";
import { TEDIX_ARTIFACTS_R2_BUCKET_NAME } from "./artifacts-contract";
import {
	DEFAULT_TRACE_SAFETY_POLICY,
	redactBundleFile,
	traceSafetyPolicyId,
} from "@tedix/context-core/trace-safety";
import { summarizeToolSteps } from "./step-telemetry";

/** One injected directive, as captured for the bundle. */
export interface TraceDirective {
	kind?: string;
	text: string;
}

/**
 * One inference step's tool + usage telemetry, captured in-DO from native Pi
 * provider-round receipts (no `diagnostics_channel` dependency). Written as
 * `tool-calls.jsonl` — the raw per-step tool/cost trace ("raw traces beat
 * summaries", `docs/cognition/harness.md`).
 */
export interface TraceToolStep {
	stepNumber: number;
	finishReason: string;
	provider?: string | null;
	model?: string | null;
	toolNames: string[];
	toolCallCount: number;
	toolResultCount: number;
	/** One-way result correlation for Observer grounding; raw result is never stored. */
	resultDigest?: string;
	usage?: Record<string, number | null>;
}

/**
 * One retrieved brain fact that was in hand for this turn (→ memory-hits.jsonl —
 * `docs/cognition/harness.md` Trace Bundle Shape "retrieved memory fact IDs and
 * scores"). Sourced from the prompt-injected brain digest the model actually saw
 * (domains indexed, fact count, budget-dropped fact ids), so it is genuine
 * in-hand retrieval evidence rather than a re-query. Every field is optional so
 * the row can carry richer per-fact ids/scores later without a shape change. The
 * shared FAIL-CLOSED redactor scrubs the row exactly like every other JSONL file.
 */
export interface TraceMemoryHit {
	/** Stable fact id when known (e.g. a budget-dropped fact). */
	factId?: string;
	/** Short, truncated summary of the retrieved fact / indexed domain. */
	summary?: string;
	/** Domain the fact belongs to, when resolved. */
	domain?: string;
	/** Retrieval/relevance score in [0,1] when known. */
	score?: number;
	/** Whether the digest budget DROPPED this fact rather than injecting it. */
	dropped?: boolean;
	/** Provenance tag for where the hit came from (e.g. "brain-digest"). */
	source?: string;
}

/**
 * One per-turn skill/guidance summary that was disclosed to the model (→
 * skills.jsonl — `docs/cognition/harness.md` Trace Bundle Shape "selected skills
 * and directives"). Sourced from the MCP runtime's `listGuidanceResources()`
 * (the same `- skill {name}: {summary}` block folded into the system prompt), so
 * it is the exact guidance surface the turn saw. The shared FAIL-CLOSED redactor
 * scrubs the row exactly like every other JSONL file.
 */
export interface TraceSkillHit {
	kind: "skill" | "guide" | "policy";
	name?: string;
	summary: string;
	uri?: string;
	serverName?: string;
}

/**
 * Recovery-exhaustion evidence recorded for an interrupted run.
 * This is the certification-evidence projection of the same recovery context
 * the ledger `run.failed` payload carries — written to the bundle as
 * `recovery.json` so a harness reviewer can join the give-up incident back to
 * the run/version/conversation without re-deriving anything.
 *
 * NEVER carries partial text content beyond the existing <=500-char prefix
 * convention; only the incident identity, the give-up reason/budget, and the
 * linkage ids belong here.
 */
export interface TraceRecoveryEvidence {
	/** Stable recovery incident identity. */
	recoveryRootRequestId: string;
	/** Per-incident id. */
	incidentId: string;
	/** Why recovery stopped. */
	reason: string;
	/** Attempts spent before the budget drained, when known. */
	attempts?: number;
	/** Max attempts the framework allowed before terminalizing. */
	maxAttempts?: number;
	/** Whether recovery was retrying a user turn or continuing a partial. */
	recoveryKind?: "retry" | "continue";
	/** Full length of the partial in chars (content itself stays out of the bundle). */
	partialTextLength: number;
	/** Always true on this path — the turn was interrupted, not a hard error. */
	interrupted?: boolean;
}

export interface TraceBundleEvidence {
	tediId: string;
	orgId?: string;
	conversationId: string;
	/** STABLE runId — the same id the ledger 4-event chain + bundle row key on. */
	runId: string;
	harnessVersionId: string;
	runtimeKind: string;
	model?: string;
	systemPrompt: string;
	userText: string;
	assistantText: string;
	directives?: TraceDirective[];
	/**
	 * Retrieved brain facts in hand for this turn (→ memory-hits.jsonl). Sourced
	 * from the prompt-injected brain digest. Omitted from the bundle when empty.
	 */
	memoryHits?: TraceMemoryHit[];
	/**
	 * Per-turn skill/guidance summaries disclosed to the model (→ skills.jsonl).
	 * Sourced from the MCP runtime guidance block. Omitted from the bundle when empty.
	 */
	skills?: TraceSkillHit[];
	/** Per-step tool/usage telemetry for this turn (→ tool-calls.jsonl). */
	toolSteps?: TraceToolStep[];
	/**
	 * Recovery-exhaustion incident for this run (→ recovery.json), present only
	 * when the caller provides a terminal recovery incident. Turns recovery
	 * telemetry into harness-certification evidence.
	 */
	recovery?: TraceRecoveryEvidence;
	outcome: "success" | "failure" | "partial" | "rolled_back";
	createdAt: string;
}

/** A bundle file before redaction: name + (string or JSON-serialisable) content. */
interface RawFile {
	name: string;
	content: unknown;
}

/**
 * Assemble the bundle file set from the evidence in hand (PURE — no I/O, no
 * redaction). Files with no content this turn (no directives) are omitted.
 */
export function assembleTraceBundleFiles(e: TraceBundleEvidence): RawFile[] {
	const files: RawFile[] = [
		{
			name: "manifest.json",
			content: {
				runId: e.runId,
				harnessVersionId: e.harnessVersionId,
				traceSafetyPolicyId: traceSafetyPolicyId(DEFAULT_TRACE_SAFETY_POLICY),
				runtimeKind: e.runtimeKind,
				model: e.model ?? null,
				tediId: e.tediId,
				orgId: e.orgId ?? null,
				conversationId: e.conversationId,
				outcome: e.outcome,
				createdAt: e.createdAt,
			},
		},
		{
			name: "prompt.json",
			content: {
				system: e.systemPrompt,
				messages: [{ role: "user", content: e.userText }],
			},
		},
		{
			name: "context.md",
			content: `# System\n\n${e.systemPrompt}\n\n# User\n\n${e.userText}\n`,
		},
		{ name: "output.md", content: `${e.assistantText}\n` },
		{
			name: "outcome.json",
			content: {
				outcome: e.outcome,
				userChars: e.userText.length,
				assistantChars: e.assistantText.length,
				directiveCount: e.directives?.length ?? 0,
			},
		},
	];
	if (e.memoryHits && e.memoryHits.length > 0) {
		files.push({
			name: "memory-hits.jsonl",
			content: e.memoryHits
				.map((m) =>
					JSON.stringify({
						factId: m.factId ?? null,
						summary: m.summary ?? null,
						domain: m.domain ?? null,
						score: m.score ?? null,
						dropped: m.dropped ?? false,
						source: m.source ?? null,
					}),
				)
				.join("\n"),
		});
	}
	if (e.directives && e.directives.length > 0) {
		files.push({
			name: "directives.jsonl",
			content: e.directives
				.map((d) => JSON.stringify({ kind: d.kind ?? null, text: d.text }))
				.join("\n"),
		});
	}
	if (e.skills && e.skills.length > 0) {
		files.push({
			name: "skills.jsonl",
			content: e.skills
				.map((s) =>
					JSON.stringify({
						kind: s.kind,
						name: s.name ?? null,
						summary: s.summary,
						uri: s.uri ?? null,
						serverName: s.serverName ?? null,
					}),
				)
				.join("\n"),
		});
	}
	if (e.toolSteps && e.toolSteps.length > 0) {
		files.push({
			name: "tool-calls.jsonl",
			content: e.toolSteps.map((s) => JSON.stringify(s)).join("\n"),
		});
		// Token/cost rollup across the turn's steps — a navigation aid over the
		// raw jsonl. Shares summarizeToolSteps with the run.completed tokensUsed
		// peek so the two turn-level counts agree; totalTokens is null (not 0)
		// when no step reported usage (the null-absent invariant).
		files.push({
			name: "scores.json",
			content: summarizeToolSteps(e.toolSteps),
		});
	}
	if (e.recovery) {
		const r = e.recovery;
		files.push({
			name: "recovery.json",
			content: {
				// Incident identity + give-up reason/budget.
				recoveryRootRequestId: r.recoveryRootRequestId,
				incidentId: r.incidentId,
				reason: r.reason,
				attempts: r.attempts ?? null,
				maxAttempts: r.maxAttempts ?? null,
				recoveryKind: r.recoveryKind ?? null,
				partialTextLength: r.partialTextLength,
				interrupted: r.interrupted ?? true,
				// Linkage back to the run/version/conversation this incident
				// terminated — the join key for harness-certification review.
				runId: e.runId,
				harnessVersionId: e.harnessVersionId,
				conversationId: e.conversationId,
			},
		});
	}
	return files;
}

/** R2 prefix for a run's raw evidence folder. */
export function traceBundlePrefix(tediId: string, runId: string): string {
	// runId may contain ':' (e.g. `${tediId}:chat:${turnKey}`) — R2 keys allow it.
	return `${tediId}/harness/runs/${runId}`;
}

/**
 * Redact every file (fail-closed) and write the bundle folder to R2. Returns the
 * `bundleUri` (folder URI) on success, or `null` if NOTHING could be written
 * (so the caller leaves `bundleUri` unset rather than pointing at an empty
 * folder). `knownSecrets` (e.g. the tedi's own provider/access keys) are scrubbed
 * longest-first in addition to the shape-based scrubbers.
 */
export async function writeTraceBundle(opts: {
	bucket: R2Bucket;
	evidence: TraceBundleEvidence;
	knownSecrets?: readonly string[];
}): Promise<string | null> {
	const { bucket, evidence } = opts;
	const knownSecrets = (opts.knownSecrets ?? []).filter(Boolean);
	const prefix = traceBundlePrefix(evidence.tediId, evidence.runId);
	let wrote = 0;
	try {
		const files = assembleTraceBundleFiles(evidence);
		for (const file of files) {
			// FAIL-CLOSED: redactBundleFile never returns raw content on error.
			const redacted = redactBundleFile(file.name, file.content, knownSecrets);
			const isMd = file.name.endsWith(".md") || file.name.endsWith(".jsonl");
			try {
				await bucket.put(`${prefix}/${redacted.name}`, redacted.content, {
					httpMetadata: {
						contentType: isMd ? "text/markdown" : "application/json",
					},
					customMetadata: {
						tediId: evidence.tediId,
						runId: evidence.runId,
						producer: "isolate-do",
						subKind: "trace_bundle",
						traceSafetyPolicyId: traceSafetyPolicyId(
							DEFAULT_TRACE_SAFETY_POLICY,
						),
						redactionFailed: String(redacted.redactionFailed),
					},
				});
				wrote += 1;
			} catch (r2Err) {
				logTediPersistenceFailure("tedi.trace.bundle_put_failed", r2Err);
			}
		}
	} catch (err) {
		logTediPersistenceFailure("tedi.trace.bundle_write_failed", err);
	}
	if (wrote === 0) return null;
	return `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/${prefix}/`;
}
