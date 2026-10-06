import assert from "node:assert/strict";
import {
	buildCalibrationResults,
	buildJudgePrompt,
	CALIBRATION_MAX_ITEMS,
	CalibrationItemsSchema,
	type ClaimInput,
	deriveJudgeStats,
	type EntailmentJudge,
	type EntailmentJudgeItem,
	type EntailmentVerdict,
	type EvidenceItem,
	type EvidenceReason,
	type EvidenceStatus,
	evaluateGroundingPolicy,
	evidenceItemId,
	exactQuoteMatch,
	extractScrapedMarkdown,
	JUDGE_PROMPT_VERSION,
	JUDGE_SPAN_MAX_CHARS,
	judgeExchangeArtifactPath,
	MIN_EXACT_QUOTE_CHARS,
	normalizeEvidenceText,
	PLATFORM_EVIDENCE_MANIFEST,
	readResearchCache,
	researchCachePath,
	resolveEntailmentLabel,
	runEntailmentJudge,
	scoreGrounding,
	sealedVerdict,
	selectCitedPassage,
	verifyJudgeSpan,
	writeResearchCache,
} from "../src/evidence-core";
import { DISPATCH_SHIM, DISPATCH_SHIM_VERSION } from "../src/runner";

// ---------------------------------------------------------------------------
// Fixtures — distinguish correlation from causal evidence.
//
// A page that reports a sales rise and separately mentions a heatwave cannot
// ground a causal claim unless it explicitly links the two.
// ---------------------------------------------------------------------------

const HEATWAVE_PAGE = `
# Fan sales weekly

Retail data for week 28 shows the Cooling Tower 3000 climbing to **#2** in the
category, up from #9 the week before. Unit volume rose 41% week over week.

## Elsewhere in the news

Meteorologists confirmed that last week was the hottest on record in Southern
Europe, with a heatwave affecting large parts of Spain and Italy.

## Methodology

Rankings are derived from aggregated retailer feeds.
`.trim();

const CAUSAL_PAGE = `
# Why the Cooling Tower 3000 is selling out

Demand for the Cooling Tower 3000 surged this week as the heatwave drove
shoppers to buy portable cooling. The retailer attributes the 41% jump in
volume directly to the record temperatures across Southern Europe.
`.trim();

/**
 * A stub judge. `attributable` verdicts carry a span, because the real contract
 * demands one — by default an HONEST span lifted verbatim out of the item's own
 * passage. A test that wants a lying judge passes `{ label, span }` explicitly.
 */
type StubVerdict = string | { label: string; span?: string };

function judgeStub(
	verdicts: Record<string, StubVerdict>,
	behavior: {
		/** Ids the judge omits from the first batch response to exercise retry. */
		dropInBatch?: string[];
		/** Ids the judge omits even on a retry — only a per-item call recovers them. */
		dropUntilSingle?: string[];
		/** Judge throws entirely. */
		throws?: boolean;
	} = {},
): { judge: EntailmentJudge; calls: EntailmentJudgeItem[][] } {
	const calls: EntailmentJudgeItem[][] = [];
	const judge: EntailmentJudge = async (items) => {
		calls.push(items);
		if (behavior.throws) throw new Error("judge exploded");
		const isSingle = items.length === 1;
		const attempt = calls.length;
		const out: EntailmentVerdict[] = [];
		for (const item of items) {
			if (behavior.dropUntilSingle?.includes(item.id) && !isSingle) continue;
			// `dropInBatch` ids are omitted on the first (batched) call only.
			if (behavior.dropInBatch?.includes(item.id) && attempt === 1) continue;
			const configured = verdicts[item.id];
			if (!configured) continue;
			const spec =
				typeof configured === "string" ? { label: configured } : configured;
			// An honest judge quotes the passage it was shown.
			const span =
				spec.span ?? (spec.label === "attributable" ? item.passage : undefined);
			out.push({
				id: item.id,
				label: spec.label,
				reason: "stub",
				...(span === undefined ? {} : { span }),
			});
		}
		return out;
	};
	return { judge, calls };
}

function item(
	id: string,
	status: EvidenceStatus,
	reason: EvidenceReason,
	extra: Partial<EvidenceItem> = {},
): EvidenceItem {
	return {
		id,
		subjectId: "cooling-tower-3000",
		url: `https://example.test/${id}`,
		title: null,
		publishedDate: null,
		quote: "q",
		claim: "c",
		sha256: "deadbeef",
		fetchedAt: "2026-07-13T00:00:00.000Z",
		status,
		reason,
		verified: status === "attributable",
		digest: `digest-${id}`,
		stage: reason.startsWith("entailment") ? "entailment" : "exact",
		judge: null,
		...extra,
	};
}

// ---------------------------------------------------------------------------
// Stage 1 — exact match
// ---------------------------------------------------------------------------

// A verbatim quote (modulo case, whitespace, curly quotes) is proof.
assert.equal(
	exactQuoteMatch(HEATWAVE_PAGE, "Unit  volume   rose 41% week over week"),
	true,
	"normalized whitespace must still match",
);
assert.equal(
	exactQuoteMatch(
		"The retailer said “demand for the Cooling Tower 3000 surged this week”",
		"demand for the Cooling Tower 3000 surged this week",
	),
	true,
	"curly quotes and case must fold",
);

// Short needles hit by accident. An accidental hit is a fabricated citation.
const shortQuote = "rose 41%";
assert.ok(shortQuote.length < MIN_EXACT_QUOTE_CHARS);
assert.equal(
	exactQuoteMatch(HEATWAVE_PAGE, shortQuote),
	false,
	"a quote below the length floor is never proof",
);
assert.equal(
	exactQuoteMatch(HEATWAVE_PAGE, "the vendor issued a full product recall"),
	false,
);

assert.equal(normalizeEvidenceText("  A—B  ‘c’  "), "a-b 'c'");

// ---------------------------------------------------------------------------
// Passage selection — the anti-conflation control
// ---------------------------------------------------------------------------

const pooled = `${CAUSAL_PAGE}\n\n${"filler. ".repeat(400)}\n\n${HEATWAVE_PAGE}`;
const passage = selectCitedPassage(
	pooled,
	"rankings are derived from aggregated retailer feeds",
	600,
);
assert.ok(
	passage.includes("aggregated retailer feeds"),
	"the window must land on the passage the item actually cites",
);
assert.ok(
	!passage.includes("attributes the 41% jump in"),
	"the window must not drag in an unrelated source's causal language",
);
assert.equal(
	selectCitedPassage("short page", "anything", 600),
	"short page",
	"a page smaller than the window is passed through whole",
);

// ---------------------------------------------------------------------------
// Stage 2 — three-way labels
// ---------------------------------------------------------------------------

const CAUSAL_SPAN =
	"The retailer attributes the 41% jump in\nvolume directly to the record temperatures across Southern Europe.";

// `attributable` + a span the judge really copied out of the passage.
assert.deepEqual(
	resolveEntailmentLabel(
		{ id: "e1", label: "ATTRIBUTABLE", span: CAUSAL_SPAN },
		"batch",
		CAUSAL_PAGE,
	),
	{
		status: "attributable",
		reason: "entailment_supported",
		label: "attributable",
		judgeReason: undefined,
		recovery: "batch",
		span: CAUSAL_SPAN,
		spanVerified: true,
	},
);
assert.equal(
	resolveEntailmentLabel({ id: "e1", label: "unsure" }, "batch", CAUSAL_PAGE)
		?.status,
	"extrapolatory",
	"an unsure judge defaults to extrapolatory, never to grounded",
);
assert.equal(
	resolveEntailmentLabel(
		{ id: "e1", label: "contradictory" },
		"batch",
		CAUSAL_PAGE,
	)?.status,
	"contradictory",
);
// A label we do not recognize is not a verdict — refusing to guess is what
// stops a garbled response from minting a grounded claim.
assert.equal(
	resolveEntailmentLabel(
		{ id: "e1", label: "probably yes?" },
		"batch",
		CAUSAL_PAGE,
	)?.status,
	"unsupported",
);
assert.equal(resolveEntailmentLabel(undefined), null);
assert.equal(
	resolveEntailmentLabel({ id: "e1" } as EntailmentVerdict),
	null,
	"a verdict with no label is a missing verdict",
);
// A caller that cannot say what the judge read cannot be told the judge was
// right: with no passage there is nothing to check the span against, so the
// only safe answer is "not proven".
assert.equal(
	resolveEntailmentLabel({ id: "e1", label: "attributable", span: CAUSAL_SPAN })
		?.status,
	"unsupported",
	"attributable is never granted without a passage to check the span against",
);

// ---------------------------------------------------------------------------
// The judge is not trusted — a verdict has to be checkable
//
// The judge is the same tedi that wrote the claim; it has the domain expertise
// AND the motive. A bare label plus a 12-word reason is an assertion, so we make
// it do what we make the tedi's own citations do: QUOTE. An `attributable`
// verdict must carry the verbatim sentence(s) from the passage that state the
// claim, and that span is checked by exact string match against the passage the
// judge was actually shown. A judge that cannot point at a real sentence has
// proven nothing.
// ---------------------------------------------------------------------------

// 1. The anti-hallucination control. A judge asserts `attributable` and invents
//    a sentence that reads exactly like a supporting one — but that sentence is
//    nowhere in the passage. Under the old contract this minted a grounded,
//    verified claim on a page that never said it. Now the string match catches
//    it and the verdict is thrown out: `unsupported` / `judge_span_unverified`.
{
	const fabricated = resolveEntailmentLabel(
		{
			id: "e1",
			label: "attributable",
			span: "The retailer confirmed the heatwave directly caused the 41% jump in the Cooling Tower 3000's sales.",
			reason: "passage states the causal link",
		},
		"batch",
		HEATWAVE_PAGE, // the page that never links the two
	);
	assert.equal(
		fabricated?.status,
		"unsupported",
		"a span that is NOT in the passage cannot ground anything, whatever the judge claims",
	);
	assert.equal(fabricated?.reason, "judge_span_unverified");
	assert.equal(fabricated?.spanVerified, false);
	// The judge's raw label survives on the record — an overreach that got caught
	// is worth keeping — but it no longer decides anything.
	assert.equal(fabricated?.label, "attributable");

	// And it grounds nothing downstream: `verified` is computed from the
	// post-check status, so the causal claim stays unsupported.
	const summary = scoreGrounding({
		claims: [{ id: "c1", kind: "causal", evidenceIds: ["e1"] }],
		evidence: [
			item("e1", fabricated!.status, fabricated!.reason, {
				stage: "entailment",
				judge: {
					label: "attributable",
					model: "stub",
					recovery: "batch",
					spanVerified: false,
				},
			}),
		],
	});
	assert.equal(summary.attributableItems, 0);
	assert.equal(
		summary.causalGroundingScore,
		0,
		"a hallucinated span must not ground a causal claim",
	);
	assert.equal(
		summary.judge.spanRejected,
		1,
		"the judge's hallucination is counted, not hidden",
	);
}

// 2. A genuine verbatim span holds — and is recorded, so a user can be shown the
//    exact sentence that backs the claim.
{
	const honest = resolveEntailmentLabel(
		{ id: "e1", label: "attributable", span: CAUSAL_SPAN },
		"batch",
		CAUSAL_PAGE,
	);
	assert.equal(honest?.status, "attributable");
	assert.equal(honest?.reason, "entailment_supported");
	assert.equal(honest?.spanVerified, true);
	assert.equal(honest?.span, CAUSAL_SPAN, "the verified sentence is retained");
}

// 3. A span too short to mean anything is not evidence. Same floor as stage 1:
//    a short needle hits by accident, and an accidental hit is a fabrication.
{
	const short = "surged this week"; // < MIN_EXACT_QUOTE_CHARS, and IS in the page
	assert.ok(normalizeEvidenceText(short).length < MIN_EXACT_QUOTE_CHARS);
	assert.ok(CAUSAL_PAGE.includes(short), "the span really is in the passage");
	const tiny = resolveEntailmentLabel(
		{ id: "e1", label: "attributable", span: short },
		"batch",
		CAUSAL_PAGE,
	);
	assert.equal(
		tiny?.status,
		"unsupported",
		"a span below the length floor proves nothing even though it occurs",
	);
	assert.equal(tiny?.reason, "judge_span_unverified");
	assert.equal(tiny?.spanVerified, false);
}

// 4. `attributable` with NO span at all — the judge skipped the evidence rule.
{
	const bare = resolveEntailmentLabel(
		{ id: "e1", label: "attributable" },
		"batch",
		CAUSAL_PAGE,
	);
	assert.equal(bare?.status, "unsupported");
	assert.equal(bare?.reason, "judge_span_missing");
	assert.equal(bare?.spanVerified, false);
	assert.equal(bare?.span, undefined);
}

// 5. A refusal needs no evidence. `extrapolatory` and `contradictory` are the
//    judge declining to attribute; there is no assertion to check, so no span is
//    required and none is invented.
{
	const refusal = resolveEntailmentLabel(
		{ id: "e1", label: "extrapolatory", reason: "no causal link stated" },
		"batch",
		HEATWAVE_PAGE,
	);
	assert.equal(refusal?.status, "extrapolatory");
	assert.equal(refusal?.reason, "entailment_extrapolatory");
	assert.equal(refusal?.spanVerified, false);
	assert.equal(refusal?.span, undefined);
	const contra = resolveEntailmentLabel(
		{ id: "e1", label: "contradictory" },
		"batch",
		HEATWAVE_PAGE,
	);
	assert.equal(contra?.status, "contradictory", "a refusal needs no span");
}

// The span check folds exactly what stage 1 folds — case, whitespace runs, and
// curly quotes — so a judge that copies faithfully is never punished for the
// scraper's typography.
{
	const page = "The retailer said “demand for the Cooling Tower 3000 surged”.";
	const check = verifyJudgeSpan(
		page,
		'DEMAND  for the "Cooling Tower 3000"  surged',
	);
	assert.equal(
		check.ok,
		false,
		"the quoted product name is not what the page said",
	);
	const faithful = verifyJudgeSpan(
		page,
		"demand for the Cooling Tower 3000 surged",
	);
	assert.equal(faithful.ok, true, "case and curly quotes fold, as in stage 1");
}
assert.equal(verifyJudgeSpan(CAUSAL_PAGE, null).ok, false);
assert.equal(verifyJudgeSpan(CAUSAL_PAGE, "   ").ok, false);
// A long span is bounded, and a bounded prefix of a real span is still a real
// span — so the cap can never turn an honest judge into a rejected one.
{
	const long = `${"x".repeat(JUDGE_SPAN_MAX_CHARS)} ${CAUSAL_SPAN}`;
	const check = verifyJudgeSpan(`${CAUSAL_PAGE}\n${long}`, long);
	assert.ok(check.span && check.span.length <= JUDGE_SPAN_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Paraphrase recovered by entailment (stage 1 misses; stage 2 saves it)
// ---------------------------------------------------------------------------

const paraphrase: EntailmentJudgeItem = {
	id: "e1",
	claim: "The Cooling Tower 3000's 41% volume jump was caused by the heatwave.",
	passage: CAUSAL_PAGE,
};
assert.equal(
	exactQuoteMatch(CAUSAL_PAGE, paraphrase.claim),
	false,
	"the claim is a paraphrase — exact match cannot see it",
);
{
	// The stub judge quotes the passage it was shown, as the prompt demands.
	const { judge } = judgeStub({
		e1: { label: "attributable", span: CAUSAL_SPAN },
	});
	const { verdicts, stats } = await runEntailmentJudge([paraphrase], judge);
	assert.equal(verdicts.get("e1")?.status, "attributable");
	assert.equal(verdicts.get("e1")?.reason, "entailment_supported");
	assert.equal(verdicts.get("e1")?.span, CAUSAL_SPAN);
	assert.equal(verdicts.get("e1")?.spanVerified, true);
	assert.deepEqual(stats, {
		requested: 1,
		resolved: 1,
		recoveredByRetry: 0,
		recoveredByItemFallback: 0,
		unavailable: 0,
		spanRejected: 0,
		spanRepaired: 0,
	});
}

// End-to-end through the ladder: a judge that fabricates its span is downgraded
// by `runEntailmentJudge` itself, and is not re-asked. Re-rolling a failed check
// until the judge produces a span that happens to pass is the opposite of a
// check — the recovery ladder exists for missing verdicts, not for failed ones.
{
	const { judge, calls } = judgeStub({
		e1: {
			label: "attributable",
			span: "The retailer confirmed the heatwave caused the 41% jump in unit volume.",
		},
	});
	const heatwaveItem: EntailmentJudgeItem = {
		id: "e1",
		claim: "The 41% jump was caused by the heatwave.",
		passage: HEATWAVE_PAGE, // never links the two
	};
	const { verdicts, stats } = await runEntailmentJudge([heatwaveItem], judge);
	assert.equal(verdicts.get("e1")?.status, "unsupported");
	assert.equal(verdicts.get("e1")?.reason, "judge_span_unverified");
	assert.equal(verdicts.get("e1")?.spanVerified, false);
	assert.equal(stats.resolved, 1, "a failed check is a verdict, not a gap");
	assert.equal(stats.unavailable, 0);
	assert.equal(stats.spanRejected, 1);
	assert.equal(calls.length, 1, "a span-rejected verdict is never re-asked");
}

// ---------------------------------------------------------------------------
// The heatwave case — extrapolatory must be rejected
//
// The page reports the price rise AND separately mentions a heatwave, and never
// links them. A binary supported/unsupported judge calls this "supported"
// because both facts are on the page. Three-way labeling is what catches it.
// ---------------------------------------------------------------------------

{
	const heatwaveItem: EntailmentJudgeItem = {
		id: "e1",
		claim:
			"The Cooling Tower 3000 climbed to #2 BECAUSE of the Southern European heatwave.",
		passage: HEATWAVE_PAGE,
	};
	// The judge refuses — and carries no span, because a refusal needs none.
	const { judge } = judgeStub({ e1: "extrapolatory" });
	const { verdicts } = await runEntailmentJudge([heatwaveItem], judge);
	const verdict = verdicts.get("e1");
	assert.equal(verdict?.status, "extrapolatory");
	assert.equal(verdict?.reason, "entailment_extrapolatory");
	assert.equal(verdict?.span, undefined, "a refusal needs no evidence");
	assert.equal(verdict?.spanVerified, false);

	const evidence = [
		item("e1", verdict!.status, verdict!.reason, {
			judge: {
				label: "extrapolatory",
				model: "stub",
				recovery: "batch",
				spanVerified: false,
			},
		}),
	];
	assert.equal(evidence[0]!.verified, false, "extrapolatory never verifies");

	const claims: ClaimInput[] = [
		{ id: "c1", kind: "causal", evidenceIds: ["e1"] },
		{ id: "c2", kind: "recommendation", evidenceIds: ["e1"] },
	];
	const summary = scoreGrounding({ claims, evidence });
	assert.equal(summary.causalClaims, 1);
	assert.equal(summary.groundedCausalClaims, 0);
	assert.equal(
		summary.causalGroundingScore,
		0,
		"the heatwave causal claim must NOT be grounded by a page that never made the link",
	);
	assert.equal(summary.groundingScore, 0);
	assert.deepEqual(summary.unsupported, [
		{
			claimId: "c1",
			kind: "causal",
			statuses: ["extrapolatory"],
			reason: "no_attributable_evidence",
		},
		{
			claimId: "c2",
			kind: "recommendation",
			statuses: ["extrapolatory"],
			reason: "no_attributable_evidence",
		},
	]);
}

// ---------------------------------------------------------------------------
// Judge failure → unsupported. Never attributable.
// ---------------------------------------------------------------------------

{
	const { judge } = judgeStub({}, { throws: true });
	const { verdicts, stats } = await runEntailmentJudge(
		[{ id: "e1", claim: "c", passage: "p" }],
		judge,
	);
	assert.equal(verdicts.size, 0, "a throwing judge yields no verdict");
	assert.equal(stats.unavailable, 1);
}
{
	// No judge configured at all (no API key).
	const { verdicts, stats } = await runEntailmentJudge(
		[{ id: "e1", claim: "c", passage: "p" }],
		null,
	);
	assert.equal(verdicts.size, 0);
	assert.deepEqual(stats, {
		requested: 1,
		resolved: 0,
		recoveredByRetry: 0,
		recoveredByItemFallback: 0,
		unavailable: 1,
		spanRejected: 0,
		spanRepaired: 0,
	});
	// An item the judge never answered is unsupported, and an unsupported item
	// grounds nothing — the score under-counts rather than over-counts.
	const summary = scoreGrounding({
		claims: [{ id: "c1", kind: "causal", evidenceIds: ["e1"] }],
		evidence: [
			item("e1", "unsupported", "entailment_unavailable", {
				stage: "entailment",
			}),
		],
	});
	assert.equal(summary.causalGroundingScore, 0);
	assert.equal(summary.attributableItems, 0);
}

// ---------------------------------------------------------------------------
// RELIABILITY: retain every verdict from batched judge calls
//
// One batched judge call per subject dropped verdicts for some items; they
// degraded to `entailment_unavailable` and real evidence was lost. Batches of
// <=4 + one retry + a per-item fallback recover them.
// ---------------------------------------------------------------------------

{
	const items: EntailmentJudgeItem[] = Array.from({ length: 6 }, (_, i) => ({
		id: `e${i + 1}`,
		claim: `claim ${i + 1}`,
		// Long enough to quote from: the stub judge cites its passage verbatim, and
		// a span below the length floor would (correctly) be rejected as evidence.
		passage: `Passage ${i + 1}: the retailer attributes the jump in volume directly to the record temperatures.`,
	}));
	const verdictMap: Record<string, StubVerdict> = Object.fromEntries(
		items.map((entry) => [entry.id, "attributable"]),
	);
	const { judge, calls } = judgeStub(verdictMap, {
		// e2 is dropped from the first batched response but answers on retry.
		dropInBatch: ["e2"],
		// e3 is dropped from every batched response — only a single-item call works.
		dropUntilSingle: ["e3"],
	});

	const { verdicts, stats } = await runEntailmentJudge(items, judge);

	// Batch retry and per-item fallback must recover both omitted verdicts.
	assert.equal(verdicts.size, 6, "every item gets a verdict");
	assert.equal(stats.requested, 6);
	assert.equal(stats.resolved, 6);
	assert.equal(stats.unavailable, 0, "no verdict is silently lost");
	assert.equal(stats.recoveredByRetry, 1, "e2 recovered by the retry");
	assert.equal(
		stats.recoveredByItemFallback,
		1,
		"e3 recovered by the per-item fallback",
	);
	assert.equal(verdicts.get("e2")?.recovery, "retry");
	assert.equal(verdicts.get("e3")?.recovery, "item_fallback");

	// Batch size is capped at 4 — 6 items is 2 batches, never one big call.
	assert.ok(
		calls.every((call) => call.length <= 4),
		"no call exceeds 4 items",
	);
	assert.equal(calls[0]?.length, 4);

	// Every recovered verdict still had to point at its passage to count.
	assert.ok(
		[...verdicts.values()].every((verdict) => verdict.spanVerified),
		"recovery does not exempt a verdict from the span check",
	);
	assert.equal(stats.spanRejected, 0);

	// The recovery rate is derivable from the sealed records alone.
	const sealed = items.map((entry) =>
		item(entry.id, "attributable", "entailment_supported", {
			stage: "entailment",
			judge: {
				label: "attributable",
				model: "stub",
				recovery: verdicts.get(entry.id)!.recovery,
				span: verdicts.get(entry.id)!.span,
				spanVerified: true,
			},
		}),
	);
	assert.deepEqual(deriveJudgeStats(sealed), {
		requested: 6,
		resolved: 6,
		recoveredByRetry: 1,
		recoveredByItemFallback: 1,
		unavailable: 0,
		spanRejected: 0,
		spanRepaired: 0,
	});
}

// ---------------------------------------------------------------------------
// Stable ids across retries
// ---------------------------------------------------------------------------

assert.equal(evidenceItemId(0), "e1");
assert.equal(evidenceItemId(4), "e5");
// Derived from the INDEX, so a replayed step produces byte-identical ids (a
// counter would drift the moment a step re-ran).
const firstPass = [0, 1, 2].map((i) => evidenceItemId(i));
const replay = [0, 1, 2].map((i) => evidenceItemId(i));
assert.deepEqual(firstPass, replay);
assert.deepEqual(firstPass, ["e1", "e2", "e3"]);
// Collision path: a second verify() call whose item 1 is a different source
// must not inherit the sealed verdict of the first call's item 1.
assert.equal(evidenceItemId(0, "abcdef0123456789"), "e1_abcdef01");
assert.notEqual(evidenceItemId(0, "abcdef0123456789"), evidenceItemId(0));

// ---------------------------------------------------------------------------
// Grounding score math
// ---------------------------------------------------------------------------

{
	const evidence = [
		item("e1", "attributable", "exact_quote_found"),
		item("e2", "attributable", "entailment_supported", { stage: "entailment" }),
		item("e3", "extrapolatory", "entailment_extrapolatory", {
			stage: "entailment",
		}),
		item("e4", "contradictory", "entailment_contradictory", {
			stage: "entailment",
		}),
	];
	const claims: ClaimInput[] = [
		{ id: "c1", kind: "observation", evidenceIds: ["e1"] },
		{ id: "c2", kind: "causal", evidenceIds: ["e2"] },
		{ id: "c3", kind: "causal", evidenceIds: ["e3", "e4"] },
		{ id: "c4", kind: "recommendation", evidenceIds: [] },
		// A claim citing an id with no host-side record grounds nothing.
		{ id: "c5", kind: "causal", evidenceIds: ["e99"] },
	];
	const summary = scoreGrounding({ claims, evidence });
	assert.equal(summary.evidenceItems, 4);
	assert.equal(summary.attributableItems, 2);
	assert.equal(summary.exactMatches, 1);
	assert.equal(summary.entailedMatches, 1);
	assert.equal(summary.causalClaims, 3);
	assert.equal(summary.groundedCausalClaims, 1);
	assert.equal(summary.causalGroundingScore, 1 / 3);
	assert.equal(summary.groundingScore, 2 / 5);
	assert.deepEqual(
		summary.unsupported.map((claim) => claim.claimId),
		["c3", "c4", "c5"],
	);
	assert.equal(
		summary.unsupported.find((claim) => claim.claimId === "c4")?.reason,
		"no_evidence_cited",
	);
	assert.deepEqual(
		summary.unsupported.find((claim) => claim.claimId === "c5")?.statuses,
		[],
		"an unresolvable evidence id contributes no status",
	);
}

// No causal claims → causal grounding is vacuously 1.
{
	const summary = scoreGrounding({
		claims: [{ id: "c1", kind: "observation", evidenceIds: ["e1"] }],
		evidence: [item("e1", "attributable", "exact_quote_found")],
	});
	assert.equal(summary.causalGroundingScore, 1);
	assert.equal(summary.groundingScore, 1);
}
{
	const summary = scoreGrounding({ claims: [], evidence: [] });
	assert.equal(summary.causalGroundingScore, 1);
	assert.equal(summary.groundingScore, 1);
	assert.deepEqual(summary.unsupported, []);
}

// ---------------------------------------------------------------------------
// Policy verdicts — warn, never fail
// ---------------------------------------------------------------------------

{
	const policy = { required: true, minCausalScore: 1 };
	const notCalled = evaluateGroundingPolicy(policy, null);
	assert.equal(notCalled.verdict, "warn");
	assert.equal(notCalled.code, "grounding_score_not_called");
	assert.equal(notCalled.causalGroundingScore, null);

	const ungrounded = evaluateGroundingPolicy(policy, {
		...scoreGrounding({
			claims: [{ id: "c1", kind: "causal", evidenceIds: ["e1"] }],
			evidence: [
				item("e1", "extrapolatory", "entailment_extrapolatory", {
					stage: "entailment",
				}),
			],
		}),
	});
	assert.equal(ungrounded.verdict, "warn");
	assert.equal(ungrounded.code, "grounding_below_min_causal_score");
	assert.ok(ungrounded.message.includes("c1"), "the warning names the claim");

	const ok = evaluateGroundingPolicy(
		policy,
		scoreGrounding({
			claims: [{ id: "c1", kind: "causal", evidenceIds: ["e1"] }],
			evidence: [item("e1", "attributable", "exact_quote_found")],
		}),
	);
	assert.equal(ok.verdict, "ok");
	assert.equal(ok.code, "grounding_satisfied");

	// A looser policy tolerates partial causal grounding.
	const loose = evaluateGroundingPolicy(
		{ required: true, minCausalScore: 0.5 },
		scoreGrounding({
			claims: [
				{ id: "c1", kind: "causal", evidenceIds: ["e1"] },
				{ id: "c2", kind: "causal", evidenceIds: ["e2"] },
			],
			evidence: [
				item("e1", "attributable", "exact_quote_found"),
				item("e2", "unsupported", "scrape_failed", { stage: "none" }),
			],
		}),
	);
	assert.equal(loose.verdict, "ok");
	assert.equal(loose.causalGroundingScore, 0.5);
}

// ---------------------------------------------------------------------------
// Scrape-result extraction — an unreadable shape reads as "no page"
// ---------------------------------------------------------------------------

assert.equal(extractScrapedMarkdown("# md"), "# md");
assert.equal(extractScrapedMarkdown({ markdown: "# md" }), "# md");
assert.equal(extractScrapedMarkdown({ data: { markdown: "# md" } }), "# md");
assert.equal(extractScrapedMarkdown({ nope: 1 }), "");
assert.equal(extractScrapedMarkdown(null), "");

// ---------------------------------------------------------------------------
// The prompt is the contract — and a verdict says which version of it decided
// ---------------------------------------------------------------------------

{
	const prompt = buildJudgePrompt([
		{ id: "e1", claim: "the heatwave drove the jump", passage: HEATWAVE_PAGE },
	]);
	// One claim, one passage, judged only against itself.
	assert.ok(prompt.includes("--- ITEM e1 ---"));
	assert.ok(prompt.includes("CLAIM: the heatwave drove the jump"));
	assert.ok(prompt.includes("PASSAGE: # Fan sales weekly"));
	assert.ok(prompt.includes("never against another item's passage"));

	// The three-way contract, including the hedge that makes `extrapolatory` the
	// default. Losing this line is how a judge starts rounding "related" up to
	// "supported".
	assert.ok(prompt.includes("USE THIS WHENEVER YOU ARE NOT SURE"));
	assert.ok(prompt.includes('"contradictory"'));

	// The span demand — the judge must quote, not assert — and the fact that the
	// span is machine-checked, stated to the judge so an honest one complies.
	assert.ok(prompt.includes("EVIDENCE RULE"));
	assert.ok(prompt.includes("CHARACTER FOR CHARACTER"));
	assert.ok(
		prompt.includes("checked against the passage by exact string match"),
	);
	assert.ok(prompt.includes("THROWN OUT"));
	assert.ok(
		prompt.includes(`shorter than ${MIN_EXACT_QUOTE_CHARS} characters`),
		"the judge is told the same length floor the checker enforces",
	);
	// A refusal needs no evidence.
	assert.ok(
		prompt.includes('"extrapolatory" and "contradictory" need no span'),
	);

	// Strict JSON, with `span` in the shape.
	assert.ok(prompt.includes('Reply with strict JSON only: {"verdicts":['));
	assert.ok(prompt.includes('"span":'));

	// The version pins the contract. Bump it whenever buildJudgePrompt changes:
	// a verdict is only replayable if the run records which prompt produced it,
	// and a silently edited prompt with a stale version makes every sealed
	// verdict unfalsifiable.
	assert.equal(JUDGE_PROMPT_VERSION, "v2-span");
}

// The judge exchange is sealed per CALL, at a path keyed by the call's sequence
// and the hash of the prompt actually sent — so the prompt and the raw reply
// behind a verdict are recoverable from the run, and a retry of an identical
// prompt (a batch that threw, re-sent whole) does not overwrite the failed
// exchange it is recovering from.
assert.equal(
	judgeExchangeArtifactPath(1, "abcdef0123456789abcdef"),
	"evidence/judge/01-abcdef012345.json",
);
assert.notEqual(
	judgeExchangeArtifactPath(2, "abcdef0123456789abcdef"),
	judgeExchangeArtifactPath(1, "abcdef0123456789abcdef"),
);

// ---------------------------------------------------------------------------
// CALIBRATION — scoring the deployed judge on fixed passages
//
// `calibrate()` is the dogfooding counterpart of eval/run-judge-eval.ts: a
// platform workflow feeds a hand-labelled gold set through the real production
// pipeline (same createMcpJudge, same runEntailmentJudge ladder, same span
// check) and reads back raw + resolved labels. No scraping — the gold labels
// were assigned per passage, so the fixed passage is the unit under test. And
// no evidence/<id>.json writes: calibration items are not run evidence, so
// score() (which reads only sealed evidence records) can never see them.
// ---------------------------------------------------------------------------

// Happy path: an honest attributable (span verified against the item's own
// passage), a refusal, and an item the judge never answers.
{
	const items: EntailmentJudgeItem[] = [
		{
			id: "g1",
			claim: "The 41% jump was caused by the heatwave.",
			passage: CAUSAL_PAGE,
		},
		{
			id: "g2",
			claim: "The Cooling Tower 3000 climbed to #2 BECAUSE of the heatwave.",
			passage: HEATWAVE_PAGE,
		},
		{ id: "g3", claim: "never answered", passage: CAUSAL_PAGE },
	];
	const { judge } = judgeStub({
		g1: { label: "attributable", span: CAUSAL_SPAN },
		g2: "extrapolatory",
		// g3 has no configured verdict — the ladder retries, falls back per-item,
		// and still gets nothing.
	});
	const { verdicts, stats } = await runEntailmentJudge(items, judge);
	const results = buildCalibrationResults(items, verdicts);

	assert.deepEqual(
		results.map((result) => result.id),
		["g1", "g2", "g3"],
		"results come back in input order",
	);
	assert.deepEqual(results[0], {
		id: "g1",
		label: "attributable",
		status: "attributable",
		reason: "entailment_supported",
		spanVerified: true,
		span: CAUSAL_SPAN,
		recovery: "batch",
	});
	assert.deepEqual(results[1], {
		id: "g2",
		label: "extrapolatory",
		status: "extrapolatory",
		reason: "entailment_extrapolatory",
		spanVerified: false,
		span: null,
		recovery: "batch",
	});
	// An unanswered item reads exactly the way verify() would record it.
	assert.deepEqual(results[2], {
		id: "g3",
		label: null,
		status: "unsupported",
		reason: "entailment_unavailable",
		spanVerified: false,
		span: null,
		recovery: null,
	});
	assert.equal(stats.requested, 3);
	assert.equal(stats.resolved, 2);
	assert.equal(stats.unavailable, 1);
}

// A fabricated span in calibration is downgraded exactly like in verify() —
// shared code path: the resolution happens inside runEntailmentJudge via the
// same resolveEntailmentLabel/verifyJudgeSpan the production verdicts take,
// and buildCalibrationResults only folds the resolved verdicts back onto the
// items. A calibration pass that flattered the judge would be worthless.
{
	const fabricatedSpan =
		"The retailer confirmed the heatwave caused the 41% jump in unit volume.";
	const items: EntailmentJudgeItem[] = [
		{
			id: "g1",
			claim: "The 41% jump was caused by the heatwave.",
			passage: HEATWAVE_PAGE, // never links the two
		},
	];
	const { judge, calls } = judgeStub({
		g1: { label: "attributable", span: fabricatedSpan },
	});
	const { verdicts, stats } = await runEntailmentJudge(items, judge);
	const [result] = buildCalibrationResults(items, verdicts);

	// Same downgrade the verify() path applies…
	assert.equal(result?.status, "unsupported");
	assert.equal(result?.reason, "judge_span_unverified");
	assert.equal(result?.spanVerified, false);
	// …with the judge's raw overreach kept on the record for scoring.
	assert.equal(result?.label, "attributable");
	assert.equal(stats.spanRejected, 1, "the fabrication is counted");
	assert.equal(calls.length, 1, "a caught fabrication is never re-rolled");
	// Byte-for-byte the same resolution resolveEntailmentLabel would produce —
	// calibration measures the shipping path, not a parallel one.
	const direct = resolveEntailmentLabel(
		{ id: "g1", label: "attributable", reason: "stub", span: fabricatedSpan },
		"batch",
		HEATWAVE_PAGE,
	);
	assert.equal(result?.status, direct?.status);
	assert.equal(result?.reason, direct?.reason);
	assert.equal(result?.spanVerified, direct?.spanVerified);
}

// Input validation — the bounds the bridge's CalibrateRequestSchema composes.
{
	const good = {
		id: "g1",
		claim: "claim",
		passage: "a passage long enough to be quoted from verbatim",
	};
	assert.equal(CalibrationItemsSchema.safeParse([good]).success, true);
	assert.equal(
		CalibrationItemsSchema.safeParse([]).success,
		false,
		"empty calibration sets are rejected",
	);
	assert.equal(CALIBRATION_MAX_ITEMS, 30);
	assert.equal(
		CalibrationItemsSchema.safeParse(
			Array.from({ length: CALIBRATION_MAX_ITEMS + 1 }, (_, i) => ({
				...good,
				id: `g${i + 1}`,
			})),
		).success,
		false,
		"a set larger than the cap is rejected",
	);
	assert.equal(
		CalibrationItemsSchema.safeParse([{ id: "g1", claim: "claim" }]).success,
		false,
		"a calibration item without a passage is rejected — there is nothing to judge against",
	);
	assert.equal(
		CalibrationItemsSchema.safeParse([{ ...good, passage: "x".repeat(4_001) }])
			.success,
		false,
		"an oversized passage is rejected",
	);
	assert.equal(
		CalibrationItemsSchema.safeParse([good, { ...good }]).success,
		false,
		"duplicate ids are rejected — verdicts are keyed by id",
	);
}

// ---------------------------------------------------------------------------
// The trust boundary — platform manifest + dispatch-shim wiring
// ---------------------------------------------------------------------------

// The platform verifies under its own manifest, so grounding works for every
// skill without the skill declaring scrape access. The manifest is the platform's
// blast radius, so it must stay MINIMAL: exactly the two tools verification
// needs — read the cited page, and ask the platform's model path to judge it —
// and nothing else. The judge uses the platform model path under the same
// capability gate and receipt contract as other MCP calls.
// Adding a third entry here widens what a verification pass can reach: don't,
// without deciding that deliberately.
assert.deepEqual(PLATFORM_EVIDENCE_MANIFEST.mcp, {
	firecrawl: ["firecrawl_scrape"],
	tedi: ["run_tedi_turn"],
});
assert.equal(PLATFORM_EVIDENCE_MANIFEST.network, false);
assert.equal(PLATFORM_EVIDENCE_MANIFEST.expectedAnnotations.destructive, false);

// env.EVIDENCE is exposed to tenant code...
assert.ok(
	DISPATCH_SHIM.includes("EVIDENCE: buildEvidenceProxy(this.env, meta)"),
);
// ...backed only by the loopback bridge stub — never by a raw binding.
assert.ok(DISPATCH_SHIM.includes("env.__EVIDENCE_BRIDGE__"));
// ...and only inside a durable step, like env.MCP.
assert.ok(DISPATCH_SHIM.includes("EVIDENCE_OUTSIDE_STEP"));
assert.ok(DISPATCH_SHIM.includes("EVIDENCE_BRIDGE_MISSING"));
// The engine's step coordinates are applied last, so a tenant-supplied
// `workflow` key can never shadow them.
assert.ok(
	DISPATCH_SHIM.includes("{ ...(args == null ? {} : args), workflow }"),
	"tenant args must not be able to override the engine step context",
);
// Only verify/score/calibrate/cacheGet/cachePut are reachable — no way to reach
// the bridge's internals. `calibrate` and the cache methods ride the same
// invoke() as verify/score, so they inherit the step guard and the engine-owned
// workflow coordinates. The cache methods memoize public research, never verdicts.
assert.ok(
	DISPATCH_SHIM.includes(
		'return { verify: invoke("verify"), score: invoke("score"), calibrate: invoke("calibrate"), cacheGet: invoke("cacheGet"), cachePut: invoke("cachePut") };',
	),
);
// A shim change must select a fresh Loader id, or cached isolates shadow it.
assert.equal(DISPATCH_SHIM_VERSION, "v45-provider-confirmation");

// --- research cache: pure path scoping + freshness --------------------------
{
	// Scoped by skillId; a tenant supplies only the key suffix, so it can never
	// address another skill's cache — the skill prefix is host-set.
	assert.equal(
		researchCachePath("5eed0021", "2026-W29:4021234"),
		"research-cache/5eed0021/2026-W29:4021234.json",
	);
	// Slashes are stripped from both segments, so a "../" can't traverse (R2 is a
	// flat keyspace; dots are harmless and kept for week/format keys).
	assert.equal(
		researchCachePath("a/b", "../../etc/passwd"),
		"research-cache/a_b/.._.._etc_passwd.json",
	);
	assert.ok(!researchCachePath("x", "a/b/c").includes("/b/"));

	const now = 1_000_000_000_000;
	const body = writeResearchCache({
		skillId: "5eed0021",
		key: "k",
		value: { products: [{ name: "PANINI" }] },
		nowMs: now,
	});
	// Fresh read returns the value.
	const fresh = readResearchCache(body, {
		nowMs: now + 1_000,
		maxAgeMs: 60_000,
	});
	assert.equal(fresh.hit, true);
	assert.deepEqual(fresh.value, { products: [{ name: "PANINI" }] });
	assert.equal(fresh.ageMs, 1_000);
	// Past the freshness bound → miss (so the discovery phase re-runs).
	const stale = readResearchCache(body, {
		nowMs: now + 120_000,
		maxAgeMs: 60_000,
	});
	assert.equal(stale.hit, false);
	assert.equal(stale.value, null);
	// No bound → always a hit if present.
	assert.equal(readResearchCache(body, { nowMs: now + 1e12 }).hit, true);
	// Miss on absent / unparseable body — never throws.
	assert.equal(readResearchCache(null, { nowMs: now }).hit, false);
	assert.equal(readResearchCache("{not json", { nowMs: now }).hit, false);
}

// --- sealedVerdict: the span check applies only to `attributable` labels ---
{
	const passage =
		"The average price of graphics cards rose by 14 percent in June according to the tracker.";
	const items: EntailmentJudgeItem[] = [
		{ id: "e1", claim: "prices rose", passage },
	];
	const honest = sealedVerdict(
		{
			id: "e1",
			label: "attributable",
			span: "The average price of graphics cards rose by 14 percent in June",
		},
		items,
	);
	assert.equal(honest.spanVerified, true);
	assert.equal(honest.spanRejection, undefined);
	const fabricated = sealedVerdict(
		{
			id: "e1",
			label: "attributable",
			span: "GPU prices fell dramatically across the whole of Europe",
		},
		items,
	);
	assert.equal(fabricated.spanVerified, false);
	assert.equal(fabricated.spanRejection, "judge_span_unverified");
	const bare = sealedVerdict({ id: "e1", label: "attributable" }, items);
	assert.equal(bare.spanVerified, false);
	assert.equal(bare.spanRejection, "judge_span_missing");
	// The raw label is normalized the same way resolveEntailmentLabel does it —
	// a judge cannot dodge the span check with " Attributable ".
	const shouty = sealedVerdict({ id: "e1", label: " Attributable " }, items);
	assert.equal(shouty.spanVerified, false);
	// A refusal owes no span: no rejection stamp, and spanVerified is null
	// ("no check applied"), never false.
	const refusal = sealedVerdict({ id: "e1", label: "extrapolatory" }, items);
	assert.equal(refusal.spanVerified, null);
	assert.equal(refusal.spanRejection, undefined);
	assert.equal(refusal.span, null);
	const contradictory = sealedVerdict(
		{ id: "e1", label: "contradictory", span: passage },
		items,
	);
	assert.equal(contradictory.spanVerified, null);
	assert.equal(contradictory.spanRejection, undefined);
	// A verdict for an id the judge was never shown has nothing to check against.
	const orphan = sealedVerdict(
		{ id: "e9", label: "attributable", span: passage },
		items,
	);
	assert.equal(orphan.spanVerified, null);
}

console.log("evidence tests passed");
