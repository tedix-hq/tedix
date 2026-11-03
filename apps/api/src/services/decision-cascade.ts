import {
	CascadeDraftSchema,
	CascadeJudgmentSchema,
	CascadeReceiptSchema,
	DecisionCascadePolicySchema,
	type CascadeCitation,
	type CascadeDraft,
	type CascadeJudgment,
	type CascadeReceipt,
	type DecisionCascadePolicy,
} from "@tedix/api-contract/schemas/decision-cascade";

export interface CascadeInput {
	request: string;
	labels: readonly string[];
	evidence: readonly (CascadeCitation & { excerpt: string })[];
	risky: boolean;
	/** Supplied by deterministic policy, never inferred from a model vote. */
	reserved: boolean;
	synthesis: boolean;
}
export interface CascadeDispatch {
	tier: "judgment" | "draft" | "strong";
	model: string;
	sampleId: string;
	perspective: "support" | "counterexample" | "missing_evidence";
	skipResponseCache: true;
	input: CascadeInput;
	judgment: CascadeJudgment | null;
}
export type CascadeResponse =
	| { status: "ok"; value: unknown; receipt: CascadeReceipt }
	| { status: "unavailable"; receipt: CascadeReceipt | null }
	| { status: "blocked"; reason: "budget" | "admission" | "accounting" };
export interface CascadeAdapters {
	/** Each call must use normal provider admission and persist its own paid usage.
	 * No fallback/retry inside this adapter; return every admitted send's receipt.
	 */
	dispatch: (request: CascadeDispatch) => Promise<CascadeResponse>;
	/** Host verifies semantic support as well as source access/freshness. */
	validateCitations: (
		label: string,
		citations: readonly CascadeCitation[],
		context: { input: CascadeInput; proposal: CascadeJudgment | CascadeDraft },
	) => boolean | Promise<boolean>;
}
export interface CascadeResult {
	status: "off" | "reserved" | "stopped" | "abstained" | "proposed";
	reason: string;
	policyRevision: string;
	proposal: CascadeDraft | null;
	receipts: CascadeReceipt[];
	/** Model output never grants permission or proves completion. */
	authorized: false;
}

/** Evaluation controller only. Production routing is unchanged until measured promotion. */
export async function evaluateDecisionCascade(
	policyInput: DecisionCascadePolicy,
	input: CascadeInput,
	adapters: CascadeAdapters,
): Promise<CascadeResult> {
	const policy = DecisionCascadePolicySchema.parse(policyInput);
	const receipts: CascadeReceipt[] = [];
	const finish = (
		status: CascadeResult["status"],
		reason: string,
		proposal: CascadeDraft | null = null,
	): CascadeResult => ({
		status,
		reason,
		proposal,
		receipts,
		policyRevision: policy.revision,
		authorized: false,
	});
	if (policy.mode === "off") return finish("off", "policy_off");
	if (input.reserved) return finish("reserved", "designated_owner_required");
	if (
		input.labels.length < 2 ||
		new Set(input.labels).size !== input.labels.length ||
		input.labels.includes("ABSTAIN")
	)
		return finish("stopped", "invalid_labels");
	if (
		new Set(input.evidence.map((row) => row.id)).size !== input.evidence.length
	)
		return finish("stopped", "ambiguous_evidence");
	const supported = async (value: CascadeJudgment | CascadeDraft) => {
		if (
			!input.labels.includes(value.label) ||
			value.confidence < policy.minConfidence ||
			!value.citations.length
		)
			return false;
		const keys = value.citations.map(
			(citation) => `${citation.id}\0${citation.revision}`,
		);
		return (
			new Set(keys).size === keys.length &&
			value.citations.every((citation) =>
				input.evidence.some(
					(row) => row.id === citation.id && row.revision === citation.revision,
				),
			) &&
			(await adapters.validateCitations(value.label, value.citations, {
				input,
				proposal: value,
			}))
		);
	};
	let calls = 0;
	let stopReason: string | null = null;
	const send = async (
		tier: CascadeDispatch["tier"],
		judgment: CascadeJudgment | null,
		index = 0,
	): Promise<unknown> => {
		if (calls >= policy.maxCalls) {
			stopReason = "call_budget";
			return null;
		}
		calls++;
		const model =
			tier === "judgment"
				? policy.judgmentModel
				: tier === "draft"
					? policy.draftModelRef
					: policy.strongModelRef;
		const response = await adapters.dispatch({
			tier,
			model,
			judgment,
			input,
			sampleId: crypto.randomUUID(),
			skipResponseCache: true,
			perspective: (["support", "counterexample", "missing_evidence"] as const)[
				index
			]!,
		});
		if (response.status === "blocked") {
			stopReason = response.reason;
			return null;
		}
		if (response.receipt) {
			const receipt = CascadeReceiptSchema.parse(response.receipt);
			if (receipts.some((row) => row.executionId === receipt.executionId)) {
				stopReason = "reused_execution";
				return null;
			}
			receipts.push(receipt);
			if (receipt.requestedModel !== model || !receipt.usagePersisted) {
				stopReason = "unreconciled_receipt";
				return null;
			}
		}
		if (response.status === "ok" && !response.receipt.resolvedModel) {
			stopReason = "unknown_resolved_model";
			return null;
		}
		return response.status === "ok" ? response.value : null;
	};
	const strong = async (reason: string): Promise<CascadeResult> => {
		const value = CascadeDraftSchema.safeParse(await send("strong", null));
		if (stopReason) return finish("stopped", stopReason);
		return value.success && (await supported(value.data))
			? finish("proposed", reason, value.data)
			: finish("abstained", "strong_unavailable_or_unsupported");
	};
	try {
		if (input.synthesis) return await strong("synthesis");
		const judgments: CascadeJudgment[] = [];
		for (
			let index = 0;
			index < (input.risky ? policy.riskySamples : 1);
			index++
		) {
			const value = CascadeJudgmentSchema.safeParse(
				await send("judgment", null, index),
			);
			if (stopReason) return finish("stopped", stopReason);
			if (!value.success || !(await supported(value.data)))
				return await strong("uncertain_or_unavailable");
			judgments.push(value.data);
		}
		if (new Set(judgments.map((value) => value.label)).size !== 1)
			return await strong("disagreement");
		const judgment = judgments[0]!;
		const draft = CascadeDraftSchema.safeParse(await send("draft", judgment));
		if (stopReason) return finish("stopped", stopReason);
		if (
			!draft.success ||
			draft.data.label !== judgment.label ||
			!(await supported(draft.data))
		)
			return await strong("draft_unsupported");
		return finish("proposed", "bounded_draft", draft.data);
	} catch {
		// An unclassified adapter error may be an admission/accounting failure.
		// Never spend again by treating that error as model uncertainty.
		return finish("stopped", "adapter_failure");
	}
}
