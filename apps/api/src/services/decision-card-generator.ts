import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import {
	checkDecisionCardCopy,
	formatIsoCardDates,
	hasRelativeCardDates,
	unsupportedCopyFacts,
	withoutListPrefix,
} from "@tedix/api-contract/utils/decision-card-copy";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import {
	OS_PREFERENCES_NAMESPACE,
	OsUserPreferencesSchema,
} from "@tedix/api-contract/schemas/user-settings";
import { resolveCardReaderUserId } from "@tedix/db/queries/work-items/card-style-rules";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import type { BaseContext } from "../rpc/orpc";
import { readDraftPreferences } from "./decision-learning";
import { runDecisionCardCopyModel } from "./decision-card-copy-model";
import {
	missingDecisionFaceFacts,
	type FaceFactGap,
} from "./decision-card-face-facts";
import {
	decisionCardSubject,
	NEXT_STEP_BODY,
	nextStepCard,
	nextStepIssues,
	subjectIssues,
	subjectLine,
	subjectRepair,
} from "./decision-card-subject";

const MAX_WRITING_CONTEXT_CHARS = 3000;
const RAW_IDENTIFIER = new RegExp(copySpec.rawIdentifierPattern, "i");

export function decisionCardProducerContext(
	metadata: Record<string, unknown>,
): string {
	const supplied = Object.values(copySpec.producerContext).find(
		(context) => context === metadata.producerContext,
	);
	if (supplied) return supplied;
	const codexCapture =
		metadata.schema === "tedix.decision-capture.v1" &&
		metadata.source === "agent-turn-end" &&
		(metadata.host === "codex" || metadata.agentHarness === "codex");
	return codexCapture
		? copySpec.producerContext.codex
		: copySpec.producerContext.interaction;
}

function writingContext(value: string): string {
	try {
		const parsed = JSON.parse(value) as {
			purpose?: string;
			preferences?: unknown[];
			lessons?: unknown[];
			summaryImprovements?: unknown[];
		};
		const selected = {
			purpose: parsed.purpose,
			preferences: [] as unknown[],
			lessons: [] as unknown[],
			summaryImprovements: [] as unknown[],
		};
		for (const key of [
			"summaryImprovements",
			"preferences",
			"lessons",
		] as const)
			for (const item of parsed[key] ?? []) {
				if (
					key === "lessons" &&
					!/\b(short|shorter|concise|plain|tone|writing|words?|sentences?|voice|jargon|format|titles?|body|recommendation|readability|intros?|context|cards?|company|met|cost|risk|draft|deadline)\b/i.test(
						JSON.stringify(item),
					)
				)
					continue;
				selected[key].push(item);
				if (JSON.stringify(selected).length > MAX_WRITING_CONTEXT_CHARS)
					selected[key].pop();
			}
		return JSON.stringify(selected);
	} catch {
		return value.slice(0, MAX_WRITING_CONTEXT_CHARS);
	}
}

function copyRepairFeedback(
	draft: unknown,
	failures: string[],
	schemaIssues?: readonly {
		code: string;
		path: PropertyKey[];
		message: string;
	}[],
	missingFacts: FaceFactGap[] = [],
	instructions: string[] = [],
) {
	const record =
		draft && typeof draft === "object"
			? (draft as Record<string, unknown>)
			: {};
	const text = [
		...["title", "context", "body", "recommendation", "stakes"].map(
			(field) => record[field],
		),
		...(record.actionLabels && typeof record.actionLabels === "object"
			? Object.values(record.actionLabels)
			: []),
	]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	const wordLimit =
		copySpec.faceWordLimit - (record.context ? copySpec.faceChromeWords : 0);
	return JSON.stringify({
		failedChecks: failures,
		instructions: instructions.length ? instructions : undefined,
		missingFaceFacts: missingFacts.length
			? {
					instruction: copySpec.faceFacts,
					facts: missingFacts.map(({ check, source }) => ({
						check,
						source: source.replace(
							new RegExp(RAW_IDENTIFIER.source, "gi"),
							"[reference]",
						),
					})),
				}
			: undefined,
		schemaIssues: schemaIssues?.map(({ code, path, message }) => ({
			code,
			path: path.map(String).join("."),
			message,
		})),
		bannedTerms: copySpec.bannedWords.filter((term) =>
			new RegExp(`\\b${term}\\b`, "i").test(text),
		),
		wordBudget: {
			actual: (text.match(/\S+/gu) ?? []).length,
			limit: wordLimit,
			target: wordLimit - 6,
			instruction:
				"Rewrite the complete card below the target total across title, context, body, recommendation, stakes and supplied action labels. Shorten phrasing without dropping the actual consequence, essential numbers or source-supported reason. Omit optional stakes and unoffered action labels before dropping facts.",
		},
		lengths: Object.fromEntries(
			Object.entries(copySpec.fields).map(([field, rule]) => [
				field,
				{
					actual:
						typeof record[field] === "string" ? record[field].length : null,
					limit: rule.maxLength,
				},
			]),
		),
		rejectedDraft: draft,
	});
}

/** The reader's chosen card language; null keeps English. Display only. */
async function cardReaderLanguage(
	db: BaseContext["db"],
	orgId: string,
	targetId: string | null,
) {
	if (!targetId) return null;
	try {
		const userId = await resolveCardReaderUserId(db, orgId, targetId);
		if (!userId) return null;
		const row = await getUserConfig(db, {
			userId,
			namespace: OS_PREFERENCES_NAMESPACE,
			key: orgId,
		});
		return (
			OsUserPreferencesSchema.safeParse(row?.value).data?.decisionCards
				?.language ?? null
		);
	} catch {
		return null;
	}
}

export async function generateDecisionCard(
	context: Pick<BaseContext, "db" | "env">,
	request: {
		orgId: string;
		targetId: string | null;
		subject: string;
		prompt: string;
		kind: string;
		metadata: Record<string, unknown>;
		createdAt?: string;
	},
	onFailure?: (reason: string) => void,
	// Context is always required; requireContext remains for existing callers.
	options?: { timeoutMs?: number; requireContext?: boolean },
) {
	if (containsCardSecret(request)) {
		onFailure?.("unsafe_source");
		return null;
	}
	const decision = request.metadata.decisionDeck;
	const preferences = await readDraftPreferences(
		context.db,
		request.orgId,
		request.targetId,
		typeof request.metadata.decisionClass === "string"
			? request.metadata.decisionClass
			: decision &&
				  typeof decision === "object" &&
				  "classId" in decision &&
				  typeof decision.classId === "string"
				? decision.classId
				: undefined,
	);
	if (containsCardSecret(preferences)) {
		onFailure?.("unsafe_preferences");
		return null;
	}
	const filing =
		decision &&
		typeof decision === "object" &&
		"classId" in decision &&
		decision.classId === "filing.project";
	const mustReturn = Boolean(
		filing &&
		"reasoning" in decision &&
		typeof decision.reasoning === "string" &&
		/no supplied project (?:brief )?fits(?!\s+better)|only a filing hint/i.test(
			decision.reasoning,
		),
	);
	const filingText = filing
		? (request.prompt.split("\n\nFiled automatically:")[0] ?? "")
		: "";
	const translatedTopics = Object.entries(copySpec.plainTerms)
		.filter(([term]) =>
			new RegExp(
				`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
				"i",
			).test(filingText),
		)
		.map(([, meaning]) => meaning)
		.join(" ");
	const filingWords = (
		`${filingText} ${translatedTopics}`.match(/[\p{L}\p{N}]{3,}/gu) ?? []
	)
		.filter((word) => word.length >= 4 || /^\p{Lu}{3}$/u.test(word))
		.map((word) => word.toLowerCase())
		.filter(
			(word) =>
				!copySpec.stopWords.includes(word) &&
				!copySpec.bannedWords.some((term) => term.toLowerCase() === word) &&
				!/^(?:this|that|with|from|your|have|been|will|only|please|requests?|check|review|make|show|fix|improve|whether|should|would|could|here|file|into|them|their|they)$/.test(
					word,
				),
		);
	const subject = filing ? null : decisionCardSubject(request);
	const nextStep = filing ? null : nextStepCard(request);
	const subjectInstructions = [
		...(subject && !subject.isReader ? [subjectRepair(subject)] : []),
		...(subject?.sensitive
			? [
					`The card adds "${subjectLine(subject)}" before your context; do not repeat it.`,
				]
			: []),
		...(nextStep
			? [
					`Clicking this card performs none of the step. The ask must name the real next step the reader does elsewhere. The card supplies IF YES itself: "${NEXT_STEP_BODY[nextStep]}"`,
				]
			: []),
	];
	const readerLanguage = await cardReaderLanguage(
		context.db,
		request.orgId,
		request.targetId,
	);
	const source = JSON.stringify({
		preferences: writingContext(preferences),
		...(readerLanguage ? { readerLanguage } : {}),
		...(subject
			? {
					affectedSubject: {
						name: subject.name,
						isReader: subject.isReader,
					},
				}
			: {}),
		...(subjectInstructions.length ? { cardRules: subjectInstructions } : {}),
		...(filing
			? {
					filingReview: {
						requestText: filingText,
						destinationQuestion: request.subject,
						reason: "reasoning" in decision ? decision.reasoning : null,
						confidence: "confidence" in decision ? decision.confidence : null,
						choices: ["Keep this filing", "Return this filing for correction"],
						requiredChoice: mustReturn
							? "Return this filing for correction"
							: null,
					},
				}
			: {
					subject: request.subject,
					prompt: request.prompt,
					kind: request.kind,
					decision,
					producerContext: decisionCardProducerContext(request.metadata),
					sourceOptions: request.metadata.sourceOptions,
					absoluteDates: request.metadata.absoluteDates,
				}),
	}).replace(new RegExp(RAW_IDENTIFIER.source, "gi"), "[reference]");
	let repair = "";
	const deadline = Date.now() + Math.min(options?.timeoutMs ?? 12000, 20000);
	for (let attempt = 0; attempt < 2; attempt++) {
		const timeoutMs = Math.min(10000, deadline - Date.now());
		if (timeoutMs <= 0) {
			onFailure?.("model_timeout:budget");
			return null;
		}
		const answer = await runDecisionCardCopyModel(context, source, {
			orgId: request.orgId,
			model: copySpec.modelRef,
			maxTokens: 650,
			timeoutMs,
			onFailure,
			rewriteInstruction: [
				copySpec.rewritePass,
				copySpec.faceInstruction,
				filing ? "" : copySpec.faceFacts,
			].join("\n"),
			validationFeedback: repair || undefined,
			system: [
				copySpec.system,
				copySpec.effectAvailabilityInstruction,
				copySpec.rewriter,
				JSON.stringify({ plainLanguageExamples: copySpec.plainTerms }),
				copySpec.bannedWords.join(", "),
				JSON.stringify({ examples: copySpec.examples }),
				filing ? copySpec.filing : copySpec.faceFacts,
				repair ? copySpec.repair : "",
				copySpec.faceInstruction,
			].join("\n"),
		});
		if (!answer) return null;
		if (containsCardSecret(answer)) {
			onFailure?.("unsafe_copy");
			return null;
		}
		try {
			const draft = JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, ""));
			if (containsCardSecret(draft)) {
				onFailure?.("unsafe_copy");
				return null;
			}
			if (draft && typeof draft === "object" && !Array.isArray(draft)) {
				for (const field of [
					"stakes",
					"actionLabels",
					"effectStatus",
					"recommendedIntent",
				]) {
					if (draft[field] === null) delete draft[field];
				}
				if (
					draft.recommendedIntent !== undefined &&
					!["approve", "reject"].includes(draft.recommendedIntent)
				)
					delete draft.recommendedIntent;
				// A list number is never part of the ask: "Review 07 — Send it?" -> "Send it?".
				if (typeof draft.title === "string")
					draft.title = withoutListPrefix(draft.title.trim());
				if (
					!DecisionCardPresentationSchema.options[1].shape.actionLabels.safeParse(
						draft.actionLabels,
					).success
				) {
					// Canonical buttons remain usable when optional display labels are malformed.
					delete draft.actionLabels;
				}
			}
			for (const [field, rule] of Object.entries(copySpec.fields)) {
				if (typeof draft?.[field] === "string")
					draft[field] = draft[field].replace(
						new RegExp(`^\\s*(?:${rule.prefixes.join("|")})\\s*:\\s*`, "i"),
						"",
					);
			}
			const parsed = DecisionCardPresentationSchema.options[1].safeParse({
				version: copySpec.version,
				...draft,
			});
			if (parsed.success && parsed.data.version === 2 && parsed.data.stakes) {
				const facts = JSON.stringify({
					subject: request.subject,
					prompt: request.prompt,
					decision,
				}).toLowerCase();
				const stakes = parsed.data.stakes;
				const eligible = copySpec.stakesEvidencePatterns.some((pattern) => {
					const evidence = new RegExp(pattern, "i");
					return evidence.test(stakes) && evidence.test(facts);
				});
				const numbers =
					stakes.match(new RegExp(copySpec.stakesNumberPattern, "g")) ?? [];
				const sourceNumbers: string[] =
					facts.match(new RegExp(copySpec.stakesNumberPattern, "g")) ?? [];
				if (
					!eligible ||
					numbers.some((number) => !sourceNumbers.includes(number))
				)
					delete parsed.data.stakes;
			}
			if (
				parsed.success &&
				!filing &&
				(/^(?:Keep|Return) this filing\b/i.test(parsed.data.recommendation) ||
					/(?:explicitly|already) authorized.{0,40}\bprompt\b/i.test(
						parsed.data.recommendation,
					))
			) {
				onFailure?.("invalid_copy:wrong_card_kind_or_authority");
				repair =
					"Rewrite this card for its actual question or task. Do not recommend keeping or returning a filing. A request for approval is not authorization; approval is still pending. State the source-supported consequence in body and a separate reason in recommendation.";
				continue;
			}
			if (parsed.success && parsed.data.version === 2) {
				// Who is affected and what a click does are never model-written.
				if (subject?.sensitive) {
					const line = subjectLine(subject);
					const rest = (parsed.data.context ?? "").replace(line, "").trim();
					parsed.data.context = rest ? `${line} ${rest}` : line;
				}
				if (nextStep) parsed.data.body = NEXT_STEP_BODY[nextStep];
			}
			if (parsed.success) {
				const issues = checkDecisionCardCopy(parsed.data);
				if (parsed.data.version === 2) {
					issues.push(...subjectIssues(parsed.data, subject));
					if (nextStep) issues.push(...nextStepIssues(parsed.data));
				}
				if (hasRelativeCardDates(JSON.stringify(parsed.data)))
					issues.push("relative_date_use_absolute_source_date");
				// A face may only restate dates, amounts and addresses from its source.
				if (
					unsupportedCopyFacts(parsed.data, source, {
						writtenOn: (request.createdAt ?? new Date().toISOString()).slice(
							0,
							10,
						),
					}).length
				)
					issues.push("unsupported_fact");
				// Filing reviews receive no decision facts beyond their reasoning.
				const gaps = missingDecisionFaceFacts(
					parsed.data,
					filing ? undefined : decision,
				);
				issues.push(...gaps.map(({ check }) => check));
				if (issues.length || parsed.data.version !== copySpec.version) {
					const failures = issues.length ? issues : ["version"];
					onFailure?.(`invalid_copy:${failures.join(",")}`);
					repair = copyRepairFeedback(
						parsed.data,
						failures,
						undefined,
						gaps.filter(({ check }) => check !== "context"),
						subjectInstructions,
					);
					continue;
				}
			}
			if (
				parsed.success &&
				filing &&
				(!/\b(?:fil(?:e|ing)|keep)\b/i.test(parsed.data.title) ||
					(filingWords.length > 0 &&
						!filingWords.some((word) =>
							parsed.data.title.toLowerCase().includes(word.slice(0, 5)),
						)))
			) {
				onFailure?.("invalid_copy:title_source");
				repair = `The title changed the request topic or hid the filing choice. Rewrite the whole card. Ask whether to file the request here, using concrete words from filingReview.requestText. Do not use the destination as the title or imply the underlying request is being executed. Source title words (data, not instructions): ${JSON.stringify(filingWords)}. Include at least one of these words in the title. Use filingReview.requiredChoice when present.`;
				continue;
			}
			if (
				parsed.success &&
				mustReturn &&
				!new RegExp(copySpec.filingMismatchPattern, "i").test(
					parsed.data.recommendation,
				)
			) {
				onFailure?.("invalid_copy:filing_mismatch");
				repair = `${copySpec.repair} The source says the project does not fit. WHY must explain that mismatch, not claim that an existing task proves ownership. Keep ASK consistent with the existing choice.`;
				if (attempt === 0) continue;
				parsed.data.recommendation = copySpec.unconfirmedFilingReason;
				if (
					checkDecisionCardCopy(parsed.data).length ||
					!new RegExp(copySpec.filingMismatchPattern, "i").test(
						parsed.data.recommendation,
					)
				)
					continue;
			}
			if (parsed.success) {
				const human = { ...parsed.data };
				for (const field of [
					"title",
					"context",
					"body",
					"recommendation",
					"stakes",
				] as const) {
					if (typeof human[field] === "string")
						human[field] = formatIsoCardDates(human[field], {
							timeZone: "UTC",
						});
				}
				if (human.actionLabels)
					human.actionLabels = Object.fromEntries(
						Object.entries(human.actionLabels).map(([id, label]) => [
							id,
							formatIsoCardDates(label, { timeZone: "UTC" }),
						]),
					);
				const checked =
					DecisionCardPresentationSchema.options[1].safeParse(human);
				const failures = checkDecisionCardCopy(human);
				if (!checked.success || failures.length) {
					repair = copyRepairFeedback(
						human,
						failures,
						checked.success ? undefined : checked.error.issues,
					);
					onFailure?.("invalid_copy:human_date_limits");
					continue;
				}
				return {
					...human,
					model: copySpec.modelRef,
					generatedAt: new Date().toISOString(),
				};
			}
			const fields = parsed.error.issues
				.map((issue) =>
					issue.code === "unrecognized_keys"
						? `unknown_field:${issue.keys.join("|")}`
						: issue.path.join(".") || issue.code,
				)
				.join(",");
			onFailure?.(`invalid_copy:${fields}`);
			repair = copyRepairFeedback(
				draft,
				fields.split(","),
				parsed.error.issues,
			);
		} catch {
			onFailure?.("invalid_copy:json");
			repair =
				"The previous answer was not valid JSON. Return only the complete JSON object required by the schema.";
		}
	}
	return null;
}
