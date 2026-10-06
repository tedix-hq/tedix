/**
 * Evidence bridge for tenant skill workflows — `env.EVIDENCE`.
 *
 * The trust boundary. A tenant workflow can present a URL and a quote; it can
 * never author the verdict. Everything that decides whether a claim is grounded
 * runs here, in the platform Worker:
 *
 *  - the page is fetched here (through the same MCP path as `env.MCP`, under a
 *    PLATFORM-owned capability manifest — a skill does not need, and cannot
 *    widen, scrape access to be verified);
 *  - the scraped bytes are digested here with the same `sha256Hex` the trusted
 *    ArtifactBridge uses, so the digest always describes what was actually read;
 *  - the exact-match and entailment verdicts are computed here;
 *  - `score()` re-reads every verdict from the SEALED host-written artifact by
 *    id and ignores any status the tenant hands back. A workflow that returns a
 *    hand-edited `verified: true` item changes nothing.
 *
 * The only thing crossing back into tenant code is a label. That asymmetry is
 * the whole point: `verified: true` is a platform assertion, not a tenant one.
 *
 * @see evidence-core.ts for the verification ladder and scoring rules.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { EVIDENCE_JUDGE_SESSION_PREFIX } from "@tedix/api-contract/utils/runtime-identity";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { sha256HexSafe } from "@tedix/db/queries/skill-run-artifacts";
import * as z from "zod";
import { recordArtifactOnceForRun } from "./artifact-immutability";
import {
	describeEvidenceFailure,
	logEvidenceFailure,
	logEvidenceJudgeSummary,
	logSkillRuntimeWarning,
} from "./control-log";
import {
	getSkillRunArtifactInlineContent,
	listSkillRunArtifactInlineContent,
} from "./db";
import {
	buildCalibrationResults,
	buildJudgePrompt,
	CalibrationItemsSchema,
	type CalibrationSummary,
	type ClaimInput,
	type EntailmentJudge,
	type EntailmentJudgeItem,
	type EntailmentJudgeResult,
	type EntailmentVerdict,
	EVIDENCE_JUDGE_METHOD,
	EVIDENCE_JUDGE_NAMESPACE,
	EVIDENCE_SCHEMA_VERSION,
	EVIDENCE_SCRAPE_METHOD,
	EVIDENCE_SCRAPE_NAMESPACE,
	type EvidenceItem,
	evaluateGroundingPolicy,
	evidenceArtifactPath,
	evidenceItemDigestInput,
	evidenceItemId,
	exactQuoteMatch,
	extractScrapedMarkdown,
	GROUNDING_POLICY_PATH,
	GROUNDING_SUMMARY_PATH,
	type GroundingPolicySnapshot,
	type GroundingPolicyVerdict,
	type GroundingSummary,
	JUDGE_ERROR_SEAL_CHARS,
	JUDGE_PROMPT_SEAL_CHARS,
	JUDGE_PROMPT_VERSION,
	JUDGE_REPLY_SEAL_CHARS,
	JUDGE_SPAN_MAX_CHARS,
	judgeExchangeArtifactPath,
	PASSAGE_WINDOW_CHARS,
	PLATFORM_EVIDENCE_MANIFEST,
	type ResearchCacheRead,
	type ResolvedEntailment,
	readResearchCache,
	researchCachePath,
	runEntailmentJudge,
	scoreGrounding,
	sealedVerdict,
	selectCitedPassage,
	writeResearchCache,
} from "./evidence-core";
import { callMcpTool, type McpBridgeProps } from "./mcp-bridge";
import type { WorkflowMcpCallContext } from "./workflow-identity";

export { JUDGE_PROMPT_VERSION, PLATFORM_EVIDENCE_MANIFEST };

/** Recorded on every sealed verdict so a run says which judge decided it. */
const JUDGE_LABEL = `${EVIDENCE_JUDGE_NAMESPACE}.${EVIDENCE_JUDGE_METHOD}`;
const SCRAPE_CONCURRENCY = 4;

const EvidenceInputSchema = z.object({
	subjectId: z.string().min(1).max(200).optional(),
	productId: z.string().min(1).max(200).optional(),
	url: z.string().url().max(2_048),
	quote: z.string().min(1).max(2_000),
	title: z.string().max(500).optional(),
	publishedDate: z.string().max(64).optional(),
	claim: z.string().max(2_000).optional(),
});

const WorkflowContextSchema = z.object({
	stepName: z.string(),
	stepCount: z.number(),
	stepType: z.string(),
	attempt: z.number(),
	phase: z.string(),
	ordinal: z.number(),
});

const VerifyRequestSchema = z.object({
	items: z.array(EvidenceInputSchema).min(1).max(50),
	workflow: WorkflowContextSchema,
});

const ClaimInputSchema = z.object({
	id: z.string().min(1).max(200),
	kind: z.enum(["observation", "causal", "recommendation"]),
	evidenceIds: z.array(z.string().min(1).max(200)).max(50),
	text: z.string().max(2_000).optional(),
});

const ScoreRequestSchema = z.object({
	claims: z.array(ClaimInputSchema).max(200),
	// Accepted for ergonomics only. Nothing but the `id` is honored: every
	// status is re-read from the sealed host-written record below.
	evidence: z
		.array(z.object({ id: z.string().min(1).max(200) }).loose())
		.max(200)
		.optional(),
});

const CalibrateRequestSchema = z.object({
	// Item shape + bounds live in evidence-core (pure, unit-testable in Bun);
	// the workflow-context requirement is the same one verify/score carry.
	items: CalibrationItemsSchema,
	workflow: WorkflowContextSchema,
});

// Research cache — memoize the expensive, variable DISCOVERY phase (firecrawl
// search + agents) so a repeat run in the same week reuses identical evidence
// instead of re-rolling it. Not a trust boundary: it stores public web research,
// not verdicts (verify/score still run host-side on whatever comes out). `workflow`
// rides along on every env.EVIDENCE call; the cache ignores it.
const CacheGetRequestSchema = z.object({
	key: z.string().min(1).max(400),
	/** Treat entries older than this as a miss (freshness bound). */
	maxAgeMs: z
		.number()
		.int()
		.positive()
		.max(90 * 24 * 3_600_000)
		.optional(),
	workflow: WorkflowContextSchema.optional(),
});

const CachePutRequestSchema = z.object({
	key: z.string().min(1).max(400),
	value: z.unknown(),
	workflow: WorkflowContextSchema.optional(),
});

export interface EvidenceBridgeEnv {
	DB: D1Database;
	SKILL_ARTIFACTS: R2Bucket;
	MCP_SERVICE: Fetcher;
}

export interface EvidenceBridgeProps {
	runId: string;
	/**
	 * The skill this run belongs to. Host-trusted, and the only scope key the
	 * research cache prefixes with — a tenant supplies just the key suffix, so it
	 * can never address another skill's cache.
	 */
	skillId: string;
	/** MCP routing/identity for the platform-owned scrape + judge calls. */
	mcp: McpBridgeProps;
}

/**
 * Ask the platform's own model path for a strict-JSON three-way verdict on each
 * (claim, passage) pair.
 *
 * This goes through the same `callMcpTool` gate as every other platform call,
 * so the judge inherits the capability check, the tool-call receipt, and the
 * idempotency identity — and needs no vendor credential of its own. The direct
 * Gemini path this replaced resolved 0/11 verdicts in production because the
 * configured key was invalid, and the failure was invisible: entailment
 * silently degraded to exact-match-only.
 *
 * Every call is SEALED before its verdicts are used: prompt version, prompt
 * hash, the raw reply, and the parsed spans with their check results land in an
 * immutable artifact. The judge's MCP calls leave no tool-call receipt (receipts
 * are written by the tenant dispatch proxy, not by `callMcpTool`), so without
 * this the single pass that decides whether a claim is grounded would be the one
 * unauditable step in the run. A verification pass nobody can inspect is not
 * evidence — it is another assertion.
 */
export function createMcpJudge(
	env: EvidenceBridgeEnv,
	props: McpBridgeProps,
	runId: string,
	workflow: WorkflowMcpCallContext,
	onError: (error: unknown) => void,
): EntailmentJudge {
	let calls = 0;
	return async (
		items: EntailmentJudgeItem[],
	): Promise<EntailmentJudgeResult> => {
		const prompt = buildJudgePrompt(items);
		const promptHash = (await sha256HexSafe(prompt)) ?? "nohash";
		const call = ++calls;
		const exchangePath = judgeExchangeArtifactPath(call, promptHash);
		const seal = (fields: Record<string, unknown>) =>
			sealJudgeExchange(env, runId, exchangePath, {
				schemaVersion: EVIDENCE_SCHEMA_VERSION,
				call,
				judge: JUDGE_LABEL,
				promptVersion: JUDGE_PROMPT_VERSION,
				promptHash,
				promptChars: prompt.length,
				promptTruncated: prompt.length > JUDGE_PROMPT_SEAL_CHARS,
				prompt: prompt.slice(0, JUDGE_PROMPT_SEAL_CHARS),
				items: items.map((item) => item.id),
				...fields,
			});

		let raw = "";
		let modelIdentity: { provider: string; model: string } | null = null;
		try {
			const result = await callMcpTool(env, props, {
				namespace: EVIDENCE_JUDGE_NAMESPACE,
				method: EVIDENCE_JUDGE_METHOD,
				args: {
					// Fresh single-use session per batch, under the SHARED blind-
					// verification prefix: no prior conversation, and the runtime
					// recognizes the key and injects no accumulated belief (compiled
					// directives / brain digest) and learns nothing from the turn. See
					// `isBlindVerificationSession` — a judge that reads its own memory
					// is not a judge.
					// `call` (the per-invocation counter already used to seal the
					// exchange) is part of both ids. Without it the reliability
					// ladder's retry reused the identical client_request_id — so a
					// "retry" was a durable-dedup echo of the failed call, never a
					// fresh sample (reused ids return pending/null or replay an older
					// run's verdicts verbatim). Reusing the session would also let a retry see the
					// earlier exchange — attempts must be independent asks. The
					// blind prefix is preserved.
					session_key: `${EVIDENCE_JUDGE_SESSION_PREFIX}${runId}:c${call}:${items.map((i) => i.id).join(",")}`,
					text: prompt,
					client_request_id: `evidence-judge:${runId}:c${call}:${items.map((i) => i.id).join(",")}`,
				},
				workflow,
			});
			raw = extractAssistantText(result);
			modelIdentity = extractModelIdentity(result);
		} catch (error) {
			// Never swallow: a judge that cannot be reached must be loud, or
			// grounding quietly collapses to exact-match-only and every paraphrase
			// reads as unsupported. That is precisely how the Gemini path hid an
			// invalid API key through a full production run.
			const message = error instanceof Error ? error.message : String(error);
			onError(error);
			// An unreachable judge belongs in the record too: a run must be able to
			// show that nothing decided this, rather than showing nothing at all.
			await seal({
				error: message.slice(0, JUDGE_ERROR_SEAL_CHARS),
				reply: null,
				verdicts: null,
			});
			return {
				verdicts: null,
				promptVersion: JUDGE_PROMPT_VERSION,
				promptHash,
			};
		}

		const verdicts = parseJudgeVerdicts(raw);
		await seal({
			modelIdentity,
			reply: raw.slice(0, JUDGE_REPLY_SEAL_CHARS),
			replyChars: raw.length,
			replyTruncated: raw.length > JUDGE_REPLY_SEAL_CHARS,
			parsed: verdicts !== null,
			// The verdicts AS PARSED, each stamped with whether its span survived the
			// check against the passage this judge was actually shown. This is the row
			// a reviewer reads to watch a judge overreach and get caught.
			verdicts:
				verdicts?.map((verdict) => sealedVerdict(verdict, items)) ?? null,
		});
		return {
			verdicts,
			promptVersion: JUDGE_PROMPT_VERSION,
			promptHash,
			exchangePath,
		};
	};
}

/** Read the additive blind-judge identity from a direct or wrapped MCP result. */
function extractModelIdentity(
	result: unknown,
): { provider: string; model: string } | null {
	const payload = (result ?? {}) as Record<string, unknown>;
	const inner = (payload.result ?? payload) as Record<string, unknown>;
	const candidate = (inner.model_identity ?? payload.model_identity) as
		| Record<string, unknown>
		| undefined;
	const provider = candidate?.provider;
	const model = candidate?.model;
	return typeof provider === "string" &&
		provider.trim() &&
		typeof model === "string" &&
		model.trim()
		? { provider, model }
		: null;
}

/**
 * Persist one judge exchange. Immutable (first writer wins, like every other
 * sealed record) and best-effort: sealing is an audit duty, not a gate. A failed
 * artifact write must not turn a resolved verdict into an unsupported one — that
 * would let a storage wobble silently degrade grounding, which is the exact
 * failure class this primitive exists to remove.
 */
async function sealJudgeExchange(
	env: EvidenceBridgeEnv,
	runId: string,
	path: string,
	value: Record<string, unknown>,
): Promise<void> {
	try {
		await recordArtifactOnceForRun(
			env.DB,
			runId,
			{ path, value, outcome: value.error ? "failure" : "success" },
			env.SKILL_ARTIFACTS,
		);
	} catch (error) {
		logEvidenceFailure("evidence.judge_exchange_seal_failed", error, runId);
	}
}

/** Pull the assistant text out of whatever shape run_tedi_turn returns. */
function extractAssistantText(result: unknown): string {
	const payload = (result ?? {}) as Record<string, unknown>;
	const inner = (payload.result ?? payload) as Record<string, unknown>;
	const assistant = (inner.assistant ?? {}) as Record<string, unknown>;
	const candidates = [assistant.content, inner.text, inner.reply, payload.text];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) return candidate;
	}
	return "";
}

/**
 * Tolerate fenced/wrapped JSON; a malformed verdict set is null, never a guess.
 *
 * Fields are copied out one by one and bounded here — a judge's `span` is
 * untrusted input on the way to a string match, and it is the only field that
 * can be long. Everything unrecognized is dropped.
 */
function parseJudgeVerdicts(raw: string): EntailmentVerdict[] | null {
	if (!raw.trim()) return null;
	let text = raw.trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(text);
	if (fenced?.[1]) text = fenced[1];
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) text = text.slice(start, end + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	const verdicts = (parsed as { verdicts?: unknown }).verdicts;
	if (!Array.isArray(verdicts)) return null;
	return verdicts.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.label !== "string") {
			return [];
		}
		return [
			{
				id: record.id.slice(0, 200),
				label: record.label,
				...(typeof record.reason === "string"
					? { reason: record.reason.slice(0, 400) }
					: {}),
				// A prefix of a span that occurs in the passage still occurs in the
				// passage, so bounding here cannot turn a real span into a rejected one.
				...(typeof record.span === "string"
					? { span: record.span.slice(0, JUDGE_SPAN_MAX_CHARS) }
					: {}),
			},
		];
	});
}

async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (cursor < items.length) {
				const index = cursor++;
				out[index] = await fn(items[index] as T, index);
			}
		},
	);
	await Promise.all(workers);
	return out;
}

/** Read the sealed evidence records for a set of ids. Host-side authority. */
async function readSealedEvidence(
	db: D1Database,
	runId: string,
	ids: string[],
): Promise<Map<string, EvidenceItem>> {
	const out = new Map<string, EvidenceItem>();
	if (ids.length === 0) return out;
	const paths = ids.map(evidenceArtifactPath);
	const rows = await listSkillRunArtifactInlineContent(db, runId, paths);
	for (const row of rows) {
		if (!row.content_inline) continue;
		try {
			const item = JSON.parse(row.content_inline) as EvidenceItem;
			if (item && typeof item.id === "string") out.set(item.id, item);
		} catch {
			// A corrupt record is not evidence. Leaving it out means the claim it
			// backs reads as ungrounded, which is the safe direction.
		}
	}
	return out;
}

export class EvidenceBridge extends WorkerEntrypoint<
	EvidenceBridgeEnv,
	EvidenceBridgeProps
> {
	/**
	 * Verify each cited source against the page it points at.
	 *
	 * Ids are `e1, e2, …` in input order, so they are identical on every retry
	 * of the step that produced them. A sealed record for an id whose content
	 * digest matches is reused verbatim (retries never re-scrape, and never
	 * re-litigate a verdict). A sealed record whose digest DIFFERS means a later
	 * `verify()` call reached the same ordinal with a different source — that
	 * item gets a digest-suffixed id rather than silently inheriting the earlier
	 * item's verdict.
	 */
	async verify(payload: unknown): Promise<EvidenceItem[]> {
		const parsed = VerifyRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`EVIDENCE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		const { runId } = this.ctx.props;
		const workflow = parsed.data.workflow as WorkflowMcpCallContext;

		// 1. Identity. Deterministic in input order, content-guarded.
		const identified = await Promise.all(
			parsed.data.items.map(async (input, index) => {
				const subjectId = input.subjectId ?? input.productId ?? null;
				const digest = await sha256Hex(
					evidenceItemDigestInput({
						url: input.url,
						quote: input.quote,
						subjectId,
					}),
				);
				return { input, index, subjectId, digest };
			}),
		);

		const sealedByOrdinal = await readSealedEvidence(
			this.env.DB,
			runId,
			identified.map((entry) => evidenceItemId(entry.index)),
		);
		const collided = identified.filter((entry) => {
			const sealed = sealedByOrdinal.get(evidenceItemId(entry.index));
			return Boolean(sealed) && sealed?.digest !== entry.digest;
		});
		const sealedByDigest = await readSealedEvidence(
			this.env.DB,
			runId,
			collided.map((entry) => evidenceItemId(entry.index, entry.digest)),
		);

		const resolved = identified.map((entry) => {
			const ordinalId = evidenceItemId(entry.index);
			const ordinalSealed = sealedByOrdinal.get(ordinalId);
			if (ordinalSealed && ordinalSealed.digest === entry.digest) {
				return { ...entry, id: ordinalId, sealed: ordinalSealed };
			}
			if (ordinalSealed) {
				const collisionId = evidenceItemId(entry.index, entry.digest);
				const digestSealed = sealedByDigest.get(collisionId);
				return {
					...entry,
					id: collisionId,
					sealed:
						digestSealed && digestSealed.digest === entry.digest
							? digestSealed
							: null,
				};
			}
			return { ...entry, id: ordinalId, sealed: null };
		});

		// 2. Scrape + stage 1 for everything not already sealed.
		const pending = resolved.filter((entry) => !entry.sealed);
		const scraped = await mapWithConcurrency(
			pending,
			SCRAPE_CONCURRENCY,
			async (entry) => {
				try {
					const result = await callMcpTool(
						this.env,
						{ ...this.ctx.props.mcp, manifest: PLATFORM_EVIDENCE_MANIFEST },
						{
							namespace: EVIDENCE_SCRAPE_NAMESPACE,
							method: EVIDENCE_SCRAPE_METHOD,
							args: {
								url: entry.input.url,
								formats: ["markdown"],
								onlyMainContent: true,
							},
							workflow,
						},
					);
					const markdown = extractScrapedMarkdown(result);
					return {
						markdown,
						fetchedAt: new Date().toISOString(),
						// Digest the bytes we actually read — the evidence, not the request.
						sha256: markdown ? await sha256HexSafe(markdown) : null,
						error: null as string | null,
					};
				} catch (error) {
					logEvidenceFailure("evidence.scrape_failed", error, runId);
					return {
						markdown: "",
						fetchedAt: new Date().toISOString(),
						sha256: null,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		);

		// 3. Stage 2 — entailment for stage-1 misses only, each against only the
		//    passage its own source cites.
		const judgeQueue: EntailmentJudgeItem[] = [];
		const stage1 = pending.map((entry, index) => {
			const page = scraped[index];
			if (!page?.markdown) {
				return { entry, page, exact: false, judged: false };
			}
			const exact = exactQuoteMatch(page.markdown, entry.input.quote);
			if (exact) return { entry, page, exact: true, judged: false };
			judgeQueue.push({
				id: entry.id,
				claim: entry.input.claim ?? entry.input.quote,
				passage: selectCitedPassage(
					page.markdown,
					entry.input.quote,
					PASSAGE_WINDOW_CHARS,
				),
			});
			return { entry, page, exact: false, judged: true };
		});

		const judgeFailures: ReturnType<typeof describeEvidenceFailure>[] = [];
		const judge = createMcpJudge(
			this.env,
			{ ...this.ctx.props.mcp, manifest: PLATFORM_EVIDENCE_MANIFEST },
			runId,
			workflow,
			(error) => {
				if (judgeFailures.length < 5)
					judgeFailures.push(describeEvidenceFailure(error));
			},
		);
		const { verdicts, stats } = await runEntailmentJudge(judgeQueue, judge);
		if (judgeQueue.length > 0) {
			// A judge that resolved nothing is an outage, not a quiet degradation:
			// every paraphrase silently becomes "unsupported" and grounding collapses
			// to exact-match-only. Log it loudly enough to be alertable.
			const dead = stats.requested > 0 && stats.resolved === 0;
			logEvidenceJudgeSummary(
				dead ? "evidence.entailment_judge_dead" : "evidence.entailment",
				{
					runId,
					judge: JUDGE_LABEL,
					promptVersion: JUDGE_PROMPT_VERSION,
					stats,
					failures: judgeFailures,
				},
			);

			// A judge that claimed support and could not point at it is a trust
			// incident, not a statistic: it is the same tedi that wrote the claim,
			// asserting its own work is grounded. The check caught it — say so, so a
			// judge (or a prompt) that starts drifting is visible before it is normal.
			if (stats.spanRejected > 0) {
				logSkillRuntimeWarning("evidence.judge_span_rejected", {
					runId,
					judge: JUDGE_LABEL,
					promptVersion: JUDGE_PROMPT_VERSION,
					spanRejected: stats.spanRejected,
					resolved: stats.resolved,
				});
			}
		}

		// 4. Label, seal, return. A sealed record always wins over a fresh verdict.
		const items = await Promise.all(
			stage1.map(async (row) => {
				const { entry, page, exact, judged } = row;
				const verdict: ResolvedEntailment | undefined = judged
					? verdicts.get(entry.id)
					: undefined;
				const item = buildEvidenceItem({
					entry,
					page,
					exact,
					judged,
					verdict,
					judgeAvailable: Boolean(judge),
					model: JUDGE_LABEL,
				});
				const sealed = await this.seal(runId, item);
				return sealed;
			}),
		);

		const byId = new Map(items.map((item) => [item.id, item]));
		return resolved.map((entry) => {
			const fresh = byId.get(entry.id);
			// Sealed-first: a retry returns the verdict the run is already bound to.
			return entry.sealed ?? (fresh as EvidenceItem);
		});
	}

	/**
	 * Score the run's claims against the evidence.
	 *
	 * `evidence` in the payload is a convenience echo — only its ids are read.
	 * Every status comes from the sealed `evidence/<id>.json` record this bridge
	 * wrote, so a workflow cannot ground a claim by asserting that it is grounded.
	 * An id with no host-side record counts as no evidence at all.
	 */
	async score(payload: unknown): Promise<GroundingSummary> {
		const parsed = ScoreRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`EVIDENCE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		const { runId } = this.ctx.props;
		const claims: ClaimInput[] = parsed.data.claims;
		const ids = [
			...new Set([
				...claims.flatMap((claim) => claim.evidenceIds),
				...(parsed.data.evidence ?? []).map((item) => item.id),
			]),
		];
		const sealed = await readSealedEvidence(this.env.DB, runId, ids);
		const summary = scoreGrounding({
			claims,
			evidence: [...sealed.values()],
		});

		// The summary is an UPSERT, not a seal — deliberately unlike the per-item
		// verdicts and judge exchanges, which stay first-write-wins. The summary is
		// a computed rollup of those sealed records plus this epoch's claims, and
		// the dispatcher's policy evaluation reads this row. Sealing it run-scoped
		// (the original behavior) made restarts judge the wrong epoch in both
		// directions: a restarted run whose new epoch genuinely grounded still
		// read epoch 0's failing summary (unclearable under enforce:"fail"), and a
		// restarted run whose new epoch degraded still read epoch 0's passing one
		// (a silent violation). Policy verdicts move per epoch; the summary they
		// are computed from must move with them. Tamper-evidence is not weakened:
		// the underlying verdicts remain sealed and content-addressed.
		const { createDbClient } = await import("@tedix/db/client");
		const { recordRunArtifact } =
			await import("@tedix/db/queries/skill-run-artifacts");
		await recordRunArtifact(createDbClient(this.env.DB), {
			runId,
			path: GROUNDING_SUMMARY_PATH,
			value: summary,
			outcome: summary.causalGroundingScore < 1 ? "failure" : "success",
		});
		console.log(
			JSON.stringify({
				service: "skill-runtime",
				event: "evidence.scored",
				runId,
				evidenceItems: summary.evidenceItems,
				attributableItems: summary.attributableItems,
				causalClaims: summary.causalClaims,
				causalGroundingScore: summary.causalGroundingScore,
			}),
		);
		return summary;
	}

	/**
	 * Calibrate the DEPLOYED judge on caller-supplied FIXED passages.
	 *
	 * This is the dogfooding counterpart of `eval/run-judge-eval.ts`: instead of
	 * re-creating the pipeline locally, a platform skill workflow feeds the gold
	 * set through the real production path — the same `createMcpJudge` (fresh
	 * blind sessions under `EVIDENCE_JUDGE_SESSION_PREFIX`, no cognitive addenda,
	 * no memory writes) driven by the same `runEntailmentJudge` ladder (batches
	 * ≤4 → retry → item fallback → span repair), with every span checked against
	 * the item's own passage. No scraping happens here, deliberately: the gold
	 * labels were assigned per passage, so a live page would invalidate them.
	 *
	 * Every judge exchange is sealed exactly as in `verify()` — the sealing
	 * lives inside `createMcpJudge` itself, so each call lands at
	 * `evidence/judge/{seq}-{hash}.json` with prompt hash, raw reply, and
	 * span-checked verdicts. That sealed trail is the only artifact calibration
	 * writes. It must never write `evidence/<id>.json` or
	 * `evidence/grounding.json`: calibration items are not run evidence, and a
	 * calibration passage must not be readable as grounding for the run's own
	 * claims.
	 *
	 * TRUST BOUNDARY: calibrate returns raw + resolved labels for SCORING the
	 * judge, but nothing it returns is usable by `score()` — `score()` re-reads
	 * only the sealed `evidence/<id>.json` records (see `readSealedEvidence`),
	 * which calibration never writes. Calibration therefore cannot mint
	 * grounding, no matter what ids or labels a workflow feeds it.
	 */
	async calibrate(payload: unknown): Promise<CalibrationSummary> {
		const parsed = CalibrateRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`EVIDENCE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		const { runId } = this.ctx.props;
		const workflow = parsed.data.workflow as WorkflowMcpCallContext;

		const judgeFailures: ReturnType<typeof describeEvidenceFailure>[] = [];
		const judge = createMcpJudge(
			this.env,
			{ ...this.ctx.props.mcp, manifest: PLATFORM_EVIDENCE_MANIFEST },
			runId,
			workflow,
			(error) => {
				if (judgeFailures.length < 5)
					judgeFailures.push(describeEvidenceFailure(error));
			},
		);
		const items: EntailmentJudgeItem[] = parsed.data.items.map((item) => ({
			id: item.id,
			claim: item.claim,
			passage: item.passage,
		}));
		const { verdicts, stats } = await runEntailmentJudge(items, judge);

		// Same loudness contract as verify(): a judge that resolved nothing is an
		// outage, and a calibration pass is precisely the run that must notice.
		const dead = stats.requested > 0 && stats.resolved === 0;
		logEvidenceJudgeSummary(
			dead ? "evidence.calibration_judge_dead" : "evidence.calibrated",
			{
				runId,
				judge: JUDGE_LABEL,
				promptVersion: JUDGE_PROMPT_VERSION,
				stats,
				failures: judgeFailures,
			},
		);

		return {
			schemaVersion: EVIDENCE_SCHEMA_VERSION,
			items: buildCalibrationResults(items, verdicts),
			stats,
			promptVersion: JUDGE_PROMPT_VERSION,
			judge: JUDGE_LABEL,
		};
	}

	/** First writer wins — a replay can never rewrite a verdict already recorded. */
	private async seal(runId: string, item: EvidenceItem): Promise<EvidenceItem> {
		await recordArtifactOnceForRun(
			this.env.DB,
			runId,
			{
				path: evidenceArtifactPath(item.id),
				value: item,
				outcome: item.status === "unsupported" ? "failure" : "success",
			},
			this.env.SKILL_ARTIFACTS,
		);
		const readBack = await readSealedEvidence(this.env.DB, runId, [item.id]);
		return readBack.get(item.id) ?? item;
	}

	/**
	 * Read a cached research entry. Returns `{hit:false}` on a miss, an unreadable
	 * body, or an entry older than `maxAgeMs`. Best-effort: never throws on a
	 * storage wobble — a cache miss just means the discovery phase runs.
	 */
	async cacheGet(payload: unknown): Promise<ResearchCacheRead> {
		const parsed = CacheGetRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`EVIDENCE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		try {
			const obj = await this.env.SKILL_ARTIFACTS.get(
				researchCachePath(this.ctx.props.skillId, parsed.data.key),
			);
			const body = obj ? await obj.text() : null;
			return readResearchCache(body, {
				maxAgeMs: parsed.data.maxAgeMs,
				nowMs: Date.now(),
			});
		} catch {
			return { hit: false, value: null, ageMs: null };
		}
	}

	/**
	 * Write a research-cache entry. Best-effort — a failed write just means the
	 * next run re-gathers; caching is an optimization, never a correctness gate.
	 */
	async cachePut(payload: unknown): Promise<{ ok: boolean }> {
		const parsed = CachePutRequestSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`EVIDENCE_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		try {
			const body = writeResearchCache({
				skillId: this.ctx.props.skillId,
				key: parsed.data.key,
				value: parsed.data.value,
				nowMs: Date.now(),
			});
			await this.env.SKILL_ARTIFACTS.put(
				researchCachePath(this.ctx.props.skillId, parsed.data.key),
				body,
				{ httpMetadata: { contentType: "application/json" } },
			);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	}
}

interface ScrapedPage {
	markdown: string;
	fetchedAt: string;
	sha256: string | null;
	error: string | null;
}

/**
 * Assemble the verdict. Fail-soft and conservative in every branch: a failed
 * scrape, an empty page, an absent judge, and a judge that never answered all
 * land on `unsupported`. Grounding is under-counted, never over-counted.
 */
function buildEvidenceItem(input: {
	entry: {
		id: string;
		digest: string;
		subjectId: string | null;
		input: z.infer<typeof EvidenceInputSchema>;
	};
	page: ScrapedPage | undefined;
	exact: boolean;
	judged: boolean;
	verdict: ResolvedEntailment | undefined;
	judgeAvailable: boolean;
	model: string;
}): EvidenceItem {
	const { entry, page, exact, judged, verdict, judgeAvailable, model } = input;
	const base = {
		id: entry.id,
		subjectId: entry.subjectId,
		url: entry.input.url,
		title: entry.input.title ?? null,
		publishedDate: entry.input.publishedDate ?? null,
		quote: entry.input.quote,
		claim: entry.input.claim ?? entry.input.quote,
		sha256: page?.sha256 ?? null,
		fetchedAt: page?.fetchedAt ?? null,
		digest: entry.digest,
	};

	if (!page || page.error) {
		return {
			...base,
			status: "unsupported",
			reason: "scrape_failed",
			verified: false,
			stage: "none",
			judge: null,
		};
	}
	if (!page.markdown) {
		return {
			...base,
			status: "unsupported",
			reason: "scrape_empty",
			verified: false,
			stage: "none",
			judge: null,
		};
	}
	if (exact) {
		return {
			...base,
			status: "attributable",
			reason: "exact_quote_found",
			verified: true,
			stage: "exact",
			judge: null,
		};
	}
	if (!judged) {
		return {
			...base,
			status: "unsupported",
			reason: "quote_missing",
			verified: false,
			stage: "none",
			judge: null,
		};
	}
	if (!verdict) {
		return {
			...base,
			status: "unsupported",
			reason: judgeAvailable ? "entailment_unavailable" : "judge_unavailable",
			verified: false,
			stage: "entailment",
			judge: null,
		};
	}
	// `verdict.status` is already the POST-CHECK status: an `attributable` label
	// whose span did not occur in the passage arrives here as `unsupported`
	// (`judge_span_missing` / `judge_span_unverified`). The judge's raw label is
	// still recorded — an overreach that got caught is worth keeping — but it can
	// no longer set `verified`.
	return {
		...base,
		status: verdict.status,
		reason: verdict.reason,
		verified: verdict.status === "attributable",
		stage: "entailment",
		judge: {
			label: verdict.label,
			...(verdict.judgeReason ? { reason: verdict.judgeReason } : {}),
			model,
			recovery: verdict.recovery,
			spanVerified: verdict.spanVerified,
			// The sentence a user can be shown as "here is what backs this claim".
			...(verdict.span ? { span: verdict.span } : {}),
			promptVersion: verdict.promptVersion ?? JUDGE_PROMPT_VERSION,
			...(verdict.promptHash ? { promptHash: verdict.promptHash } : {}),
			...(verdict.exchangePath ? { exchangePath: verdict.exchangePath } : {}),
		},
	};
}

/**
 * Grounding-policy enforcement, run by the dispatcher after the tenant workflow
 * returns. Warns, never fails: hard-failing a run for a missing grounding
 * receipt would break every skill authored before this primitive, and a run that
 * did real work should not be destroyed to punish a missing call. The verdict is
 * durable evidence at `evidence/policy.json`, so an ungrounded run is visible to
 * the dashboard and API without being unrecoverable.
 */
export async function enforceGroundingPolicy(input: {
	db: D1Database;
	artifacts: R2Bucket;
	runId: string;
	policy: GroundingPolicySnapshot;
}): Promise<GroundingPolicyVerdict> {
	const content = await getSkillRunArtifactInlineContent(
		input.db,
		input.runId,
		GROUNDING_SUMMARY_PATH,
	);

	let summary: GroundingSummary | null = null;
	if (content) {
		try {
			summary = JSON.parse(content) as GroundingSummary;
		} catch {
			summary = null;
		}
	}

	const verdict = evaluateGroundingPolicy(input.policy, summary);
	if (verdict.verdict === "warn") {
		logSkillRuntimeWarning("evidence.grounding_policy_warning", {
			runId: input.runId,
			policyCode: verdict.code,
			causalGroundingScore: verdict.causalGroundingScore,
			minCausalScore: input.policy.minCausalScore,
		});
	}

	// The policy verdict is re-evaluated per epoch (an operator restart must be
	// able to clear a warning), so this path is a normal upsert — unlike the
	// evidence records and the grounding summary, which are sealed.
	const { createDbClient } = await import("@tedix/db/client");
	const { recordRunArtifact } =
		await import("@tedix/db/queries/skill-run-artifacts");
	await recordRunArtifact(createDbClient(input.db), {
		runId: input.runId,
		path: GROUNDING_POLICY_PATH,
		value: { ...verdict, schemaVersion: EVIDENCE_SCHEMA_VERSION },
		outcome: verdict.verdict === "warn" ? "failure" : "success",
	});
	return verdict;
}
