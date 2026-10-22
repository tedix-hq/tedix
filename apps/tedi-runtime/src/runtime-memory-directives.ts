import {
	type CompiledDirective,
	diagnoseDirectiveGap,
	directiveInfluenced,
	directiveInfluenceRatio,
	markDirectiveMatched,
	recordDirectiveInfluence,
	selectMatchingDirectives,
	serializeMatchedDirectives,
} from "@tedix/context-core/compiler";
import { compileDirectives } from "./brain/compiler";
import { logTediSourceFailure } from "./context-failure-log";
import type { ActiveTurnBinding } from "./runtime-state";
import type { RuntimeMemoryHost } from "./runtime-memory";

/**
 * The payload shapes that share the `context.injected` ledger kind
 * (deliberately — no new enum value), discriminated by `source` + `phase`:
 * directive pre-turn INJECTION (which compiled directives matched this turn's
 * user text), directive post-turn INFLUENCE (whether each injected directive
 * detectably steered the reply), and skill-retrieval pre-turn INJECTION
 * ({@link SkillRetrievalTelemetryPayload}). Consumers today key on `kind`
 * only; `source`/`phase` are the contract for anyone who needs to tell the
 * shapes apart.
 */
type DirectiveTelemetryPayload =
	| {
			source: "compiled-directives";
			phase: "pre-turn-injection";
			matched: number;
			directives: Array<{
				category: string;
				strength: CompiledDirective["strength"];
				provenanceHash: string;
				evidenceCount: number;
			}>;
	  }
	| {
			source: "compiled-directives";
			phase: "post-turn-influence";
			heuristic: "keyword-overlap";
			evaluated: number;
			influenced: number;
			directives: Array<{
				category: string;
				strength: CompiledDirective["strength"];
				provenanceHash: string;
				influenced: boolean;
				ratio: number;
				successRate: number;
			}>;
	  };

/** Lazy-load the compiled-directive cache from DO SQLite (once per instance). */
export async function ensureDirectivesLoaded(
	this: RuntimeMemoryHost,
): Promise<void> {
	if (this.directivesLoaded) return;
	try {
		this.compiledDirectives = await this.getDirectiveStore().load();
	} catch (err) {
		logTediSourceFailure("directives", "load", err);
		this.compiledDirectives = [];
	}
	this.directivesLoaded = true;
}

/**
 * Compiled directives (Atlas-style ALWAYS/NEVER/PREFER rules) injected into the
 * system prompt per-turn in {@link beforeTurn}. Loaded lazily from DO storage on
 * first use; refreshed by {@link onCompileDirectives}.
 *
 * **Directive precision (selective matching).** Rather than serializing the
 * ENTIRE cache every turn, this mirrors
 * The prompt-build hook matches
 * each cached directive's wording against the current turn's user text via
 * keyword overlap and injects ONLY the matching, well-evidenced directives.
 *
 * Side effects (fail-soft):
 *  - marks matched directives' `lastMatchedAt` (in-memory + persisted via the
 *    store's `updateLastMatched`), so the 14-day stale-prune keeps used ones;
 *  - records a `context.injected` runtime event capturing which directives
 *    (category + provenanceHash) matched — the isolate's usage signal, the
 *    closest available runtime parity for directive influence telemetry.
 *
 * Returns "" when nothing matches (the common case for young tedis or
 * off-topic turns), so the prompt is unchanged.
 */
export async function directivesPromptAddendum(
	this: RuntimeMemoryHost,
	userText: string,
	telemetryBinding?: ActiveTurnBinding | null,
): Promise<string> {
	await this.ensureDirectivesLoaded();
	if (this.compiledDirectives.length === 0) return "";

	const matches = selectMatchingDirectives(this.compiledDirectives, userText);
	if (matches.length === 0) return "";

	// 1) Mark matched directives as recently used (in-memory cache) + persist.
	const now = new Date().toISOString();
	for (const m of matches) {
		markDirectiveMatched(this.compiledDirectives, m.index, now);
	}
	try {
		await this.getDirectiveStore().updateLastMatched(
			matches.map((m) => ({
				directive: this.compiledDirectives[m.index]!,
				index: m.index,
			})),
		);
	} catch (err) {
		// Persistence is best-effort; the in-memory mark still applies this turn.
		logTediSourceFailure("directives", "touch", err);
	}

	// 2) Record a lightweight directive-usage signal (best-effort). The
	// binding is threaded EXPLICITLY because the bespoke SSE/workflow turn
	// families don't maintain `this.activeTurnBinding` — relying on it
	// implicitly is why `context.injected` events never fired off the
	// native Pi path.
	void this.recordDirectiveUsage(
		matches,
		telemetryBinding ?? this.activeTurnBinding,
	).catch(() => {
		/* fail-soft — never break a turn on a telemetry write */
	});

	// 3) Carry the injected directives (with their cache index) to the
	// post-turn INFLUENCE check (`recordDirectiveInfluenceForTurn`), the
	// other half of directive influence telemetry: we recorded that
	// these directives were INJECTED; once the assistant reply is known we
	// estimate whether each one INFLUENCED it and recalibrate confidence.
	this.lastInjectedDirectives = matches.map((m) => ({
		directive: this.compiledDirectives[m.index]!,
		index: m.index,
	}));

	return serializeMatchedDirectives(matches);
}

/**
 * Record which compiled directives matched the current turn as a
 * `context.injected` runtime event. This is the isolate's nearest parity for
 * directive influence telemetry — there is no dedicated
 * `recordDirectiveUsage` RPC on `HttpPlatformClient`, so we route through the
 * existing `recordRuntimeEvent` ledger surface rather than inventing a new RPC.
 *
 * This records that matched directives were INJECTED. The complementary
 * INFLUENCE signal — whether a directive actually steered the reply — is
 * computed post-turn by {@link recordDirectiveInfluenceForTurn} (called from
 * `onChatResponse` once the assistant text is known), which recalibrates each
 * directive's `successRate` confidence. Together they close the
 * Phase-1 influence-attribution gap, mirroring the runtime's
 * `usageRatioBoost`/`recordDirectiveBoost` (injected vs. used) spirit.
 */
export async function recordDirectiveUsage(
	this: RuntimeMemoryHost,
	matches: Array<{ directive: CompiledDirective }>,
	binding?: ActiveTurnBinding | null,
): Promise<void> {
	const ctx = await this.resolveTurnTelemetry({ binding });
	if (!ctx) return;
	const { tediId, runId, conversationId, platform } = ctx;
	const sequence = this.directiveEventSequence++;
	const payload: DirectiveTelemetryPayload = {
		source: "compiled-directives",
		phase: "pre-turn-injection",
		matched: matches.length,
		directives: matches.map(({ directive: d }) => ({
			category: d.category,
			strength: d.strength,
			provenanceHash: d.provenanceHash,
			evidenceCount: d.evidenceCount,
		})),
	};
	await platform.recordRuntimeEvent({
		id: `${runId}:directives:${sequence}`,
		tediId,
		kind: "context.injected",
		conversationId,
		runId,
		sequence,
		payload,
		runtime: { backend: "cloudflare-agents" },
		createdAt: new Date().toISOString(),
	});
}

/**
 * Post-turn INFLUENCE attribution — closes the gap the Phase-1 TODO left in
 * {@link recordDirectiveUsage}: that path records that matched directives were
 * INJECTED; this one estimates whether each one INFLUENCED the assistant reply
 * and feeds the signal back into directive confidence, mirroring the runtime's
 * `usageRatioBoost`/`recordDirectiveBoost` (which lives on retrieved brain
 * facts) for compiled directives instead.
 *
 * HEURISTIC, not ground truth: there is no causal trace from a directive to a
 * token, so "influenced" is approximated by keyword overlap between the
 * directive's wording and the assistant's reply
 * (`directiveInfluenced` / `DIRECTIVE_INFLUENCE_MIN_RATIO`). Effects are
 * deliberately weak — a small EMA nudge to `successRate` per turn
 * (`recordDirectiveInfluence`) — so noise self-corrects over many turns and a
 * single off-topic reply never flips a directive. We never hard-delete: a
 * directive that drifts to low confidence is left for the existing
 * stale-prune + negative-feedback invalidation paths to own.
 *
 * Fail-soft + idempotent: consumes `lastInjectedDirectives` (cleared here), so
 * a second call for the same turn is a no-op; any error is swallowed so the
 * turn is never broken by a confidence write.
 */
export async function recordDirectiveInfluenceForTurn(
	this: RuntimeMemoryHost,
	assistantText: string,
	binding?: ActiveTurnBinding | null,
): Promise<void> {
	const injected = this.lastInjectedDirectives;
	this.lastInjectedDirectives = null;
	if (!injected || injected.length === 0) return;
	const reply = assistantText.trim();
	if (!reply) return;

	// Recalibrate confidence in the in-memory cache + collect the persist set.
	const updates: Array<{ directive: CompiledDirective; index: number }> = [];
	const influenceReport: Array<{
		category: string;
		strength: CompiledDirective["strength"];
		provenanceHash: string;
		influenced: boolean;
		ratio: number;
		successRate: number;
	}> = [];
	for (const { directive, index } of injected) {
		// The cache may have been reloaded between inject + now (failure
		// invalidation drops `directivesLoaded`); skip stale indices/rows.
		const current = this.compiledDirectives[index];
		if (!current || current !== directive) continue;
		const ratio = directiveInfluenceRatio(current.directive, reply);
		const influenced = directiveInfluenced(current.directive, reply);
		const successRate = recordDirectiveInfluence(
			this.compiledDirectives,
			index,
			influenced,
		);
		updates.push({ directive: current, index });
		influenceReport.push({
			category: current.category,
			strength: current.strength,
			provenanceHash: current.provenanceHash,
			influenced,
			ratio: Math.round(ratio * 100) / 100,
			successRate: Math.round(successRate * 100) / 100,
		});
	}
	if (updates.length === 0) return;

	// Persist the recalibrated confidence (best-effort, in-place blob UPDATE).
	try {
		await this.getDirectiveStore().recordInfluence(updates);
	} catch (err) {
		logTediSourceFailure("directives", "persist_influence", err);
	}

	// Record a lightweight influence telemetry event (the post-turn half of
	// DirectiveTelemetryPayload). Uses the ACTUAL turn binding (captured in
	// beforeTurn, passed in from onChatResponse before it cleared
	// activeTurnBinding) so the influence event correlates with the turn it
	// scored — the explicit `!binding` guard keeps a late call from
	// rebinding to some OTHER turn's activeTurnBinding via the resolver's
	// fallback.
	try {
		if (!binding?.runId) return;
		const ctx = await this.resolveTurnTelemetry({ binding });
		if (!ctx) return;
		const { tediId, runId, conversationId, platform } = ctx;
		const sequence = this.directiveEventSequence++;
		const payload: DirectiveTelemetryPayload = {
			source: "compiled-directives",
			phase: "post-turn-influence",
			heuristic: "keyword-overlap",
			evaluated: influenceReport.length,
			influenced: influenceReport.filter((r) => r.influenced).length,
			directives: influenceReport,
		};
		await platform.recordRuntimeEvent({
			id: `${runId}:directives:${sequence}`,
			tediId,
			kind: "context.injected",
			conversationId,
			runId,
			sequence,
			payload,
			runtime: { backend: "cloudflare-agents" },
			createdAt: new Date().toISOString(),
		});
	} catch (err) {
		logTediSourceFailure("directives", "emit_influence", err);
	}
}

/**
 * Directive-compile alarm. Compiles the tedi's completed rationale corpus
 * into Atlas-style ALWAYS/NEVER/PREFER directives (`compileDirectives` from
 * `src/brain/`; runtime parity — `refreshDirectives` in
 * tedix-context), persists them to DO SQLite, and refreshes the in-memory
 * cache that {@link directivesPromptAddendum} injects into the system prompt.
 *
 * Uses the template (fallback) compiler — no per-compile LLM cost. Returns
 * `[]` until the corpus crosses `PROMOTION_THRESHOLD` completed records, so
 * young tedis simply get no directives. Compilation failures propagate to the
 * owning maintenance operation; the prior cached directives stay active.
 */
export async function onCompileDirectives(
	this: RuntimeMemoryHost,
	admittedRunId: string,
): Promise<void> {
	if (typeof admittedRunId !== "string" || !admittedRunId.trim())
		throw new Error("Maintenance compilation requires its original run ID");
	await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
	await this.ensureIdentity();
	const nativePlatform = await this.getPlatformClient();
	const platform =
		nativePlatform && this.admittedEffectPort(nativePlatform, admittedRunId);
	if (!platform) throw new Error("Maintenance platform is unavailable");
	// Timeout-guard the compile: it makes an HTTP `getRationaleChain` call,
	// and this runs in the DO's alarm context — a hung upstream must not
	// wedge the DO. The 20s ceiling fails the owning maintenance operation.
	const directives = await Promise.race([
		compileDirectives({ platform }),
		new Promise<CompiledDirective[]>((_, reject) =>
			setTimeout(
				() => reject(new Error("compileDirectives timed out")),
				20_000,
			),
		),
	]);
	await this.runtimeAdmission()?.assertAcceptedTurn({ runId: admittedRunId });
	await this.getDirectiveStore().save(directives);
	this.compiledDirectives = directives;
	this.directivesLoaded = true;
	if (directives.length > 0) {
		console.log(
			`[isolate.directives] compiled=${directives.length} tedi=${this.state.slug}`,
		);
	} else {
		// No directives — run the gap diagnostic so operators can see WHY.
		// This is a read of the same rationale chain (cheap, no LLM) and
		// emits a structured log instead of silent [].
		try {
			const { data: records } = await platform.getRationaleChain(50);
			const gap = diagnoseDirectiveGap(
				(records || []).map((r) => ({
					id: r.id,
					action: r.action,
					category: r.category,
					outcome: r.outcome ?? undefined,
					outcomeStatus: r.outcomeStatus,
				})),
			);
			console.log(
				`[isolate.directives] zero-directive gap: reason=${gap.reason} ` +
					`total=${gap.totalRecords} completed=${gap.completedRecords} ` +
					`clusters=${gap.clusters} promoted=${gap.promotedClusters} ` +
					`tedi=${this.state.slug}`,
			);
		} catch {
			// Gap diagnostic is best-effort — never break the alarm.
		}
	}
}
