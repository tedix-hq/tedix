import type * as z from "zod";
import { deckResponseRequiresHuman } from "./deck-action-boundary";
import copySpec from "../assets/decision-card-copy.v2.json";
import {
	checkDecisionCardCopy,
	decisionCardActionLabel,
	decisionCardFallbackTitle,
	renderDecisionCardDates,
} from "./decision-card-copy";
import { containsCardSecret } from "./card-secrets";
import { isRecord } from "./is-record";
import { DECK_ASK_LABELS } from "./deck-ask";
import type { JsonValue } from "../schemas/common";
import { AttentionOfferedChoicesSchema } from "../schemas/attention";
import type {
	DeckCard,
	AttentionDisplayCard,
	ForYouProjectionSchema,
} from "../schemas/attention";
import { DecisionCardPresentationSchema } from "../schemas/decision-card-presentation";
import { PersonalAgentContributionSchema } from "../schemas/personal-agent-inbound";
import {
	classifyDeckCard,
	type DeckRoutingPolicy,
} from "../schemas/os-decision-deck";

const OS = "https://tedix.os.tedix.dev";
function checkedCopy(value: unknown) {
	const copy = DecisionCardPresentationSchema.safeParse(value).data;
	return copy?.version === 2 &&
		copy.context &&
		!checkDecisionCardCopy(copy).length
		? copy
		: null;
}
export function attentionSource(source: string): string {
	if (containsCardSecret(source)) return `${OS}/work`;
	if (source.startsWith("/") && !source.startsWith("//"))
		return `${OS}${source}`;
	try {
		const url = new URL(source);
		if (url.protocol === "https:") return url.href;
	} catch {
		/* Opaque evidence references are displayed in the OS. */
	}
	return `${OS}/work`;
}

export function deckDisplayCard(
	card: DeckCard,
	index: number,
	input: { gadgetId?: string; timeZone?: string } = {},
	routing?: DeckRoutingPolicy,
): AttentionDisplayCard {
	const request = card.interaction?.request;
	const metadata = request?.metadata ?? {};
	const offered = AttentionOfferedChoicesSchema.safeParse(metadata).data;
	// Null is the prepared projection's rejection of stale or unavailable copy.
	const storedCopy = checkedCopy(
		card.presentation === undefined
			? metadata.cardPresentation
			: card.presentation,
	);
	const copy = storedCopy
		? renderDecisionCardDates(
				storedCopy,
				[card.dueAt, card.deadline].filter((date): date is string =>
					Boolean(date),
				),
				new Date(),
				input.timeZone,
			)
		: null;
	const personal =
		request?.creatorType === "system"
			? PersonalAgentContributionSchema.safeParse(
					metadata.personalAgentContribution,
				).data
			: undefined;
	const outbound = card.interaction?.outbound?.outbound.draft;
	const draft =
		outbound?.body ??
		card.decision?.preview?.body ??
		card.factory?.draft ??
		null;
	const critical =
		classifyDeckCard(
			{
				kind: card.kind,
				classId:
					card.decision?.classId ?? String(metadata.decisionClass ?? card.kind),
				needsPerson: true,
				risk:
					card.workApproval?.workItem.riskLevel ??
					String(metadata.riskLevel ?? ""),
				action:
					card.runtimeApproval?.actionType ??
					String(metadata.approvalOperation ?? request?.prompt ?? ""),
				protectedEffects: card.decision?.protectedEffects,
			},
			routing,
		).reason === "critical";
	const view: AttentionDisplayCard = {
		id: card.id,
		kind: card.kind,
		ask: copy?.title ?? decisionCardFallbackTitle(card.label),
		context: copy?.context ?? null,
		confidence: card.decision?.confidence ?? null,
		ifYes:
			copy?.body ??
			(card.faceText === copySpec.unavailableFace
				? copySpec.unavailableFace
				: copySpec.pendingFace),
		why: copy?.recommendation ?? null,
		stakes: copy && "stakes" in copy ? (copy.stakes ?? null) : null,
		provenance: personal
			? `${personal.sourceAgentName} · personal agent`
			: (card.interaction?.askedBy ?? (card.factory ? "Factory" : "Tedix")),
		evidenceUrl: personal?.evidenceUrl ?? null,
		dueAt: card.deadline ?? card.dueAt,
		askKind: card.askKind ?? null,
		askLabel: card.askKind ? DECK_ASK_LABELS[card.askKind] : null,
		overdue: card.overdue ?? false,
		...(card.handled ? { handled: true } : {}),
		...(card.expired ? { expired: true } : {}),
		draftedNotSent: card.draftedNotSent ?? false,
		source: attentionSource(card.source),
		draft: containsCardSecret(draft) ? null : draft,
		recipient: outbound?.recipient ?? null,
		subject: outbound?.subject ?? null,
		options:
			card.decision?.options.map((option) => ({
				id: option.id,
				label: option.label,
				consequence: option.consequence,
			})) ?? [],
		actions: [],
		answer: "",
		needsText: false,
		status: null,
	};
	const add = (
		id: string,
		label: string,
		args: Record<string, JsonValue>,
		textArgumentPath: string | null = null,
	) => {
		const intent =
			card.decision?.options.find((option) => option.id === id)?.intent ??
			(id === "useful"
				? "approve"
				: id === "not_useful"
					? "reject"
					: undefined);
		view.actions.push({
			id,
			label: decisionCardActionLabel(copy, id, intent, label),
			arguments: {
				decision: {
					...args,
					...(input.gadgetId ? { gadgetId: input.gadgetId } : {}),
					...(input.timeZone ? { timeZone: input.timeZone } : {}),
				},
			},
			textPath: textArgumentPath ? `/cards/${index}/answer` : null,
			textArgumentPath: textArgumentPath
				? `/decision${textArgumentPath}`
				: null,
			statusPath: `/cards/${index}/status`,
		});
		if (textArgumentPath) view.needsText = true;
	};
	// Critical consent and approvals with interactive takeover stay in the OS.
	if (containsCardSecret(view))
		return {
			...view,
			options: [],
			draft: null,
			recipient: null,
			subject: null,
			provenance: "Tedix",
			evidenceUrl: null,
		};
	if (!copy || critical || card.runtimeApproval?.review.interaction)
		return view;
	if (!card.factory && deckResponseRequiresHuman(card, "")) return view;
	if (
		(card.kind === "outbound" ||
			card.decision?.protectedEffects.includes("message")) &&
		!draft
	)
		return view;
	if (request && card.interaction?.canRespond) {
		// Outbound approval has its own reviewed draft lifecycle; a generic answer must not imply sending.
		if (metadata.schema === "tedix.outbound.v1") return view;
		const base = {
			requestId: request.id,
			expectedRequestVersion: request.version,
		};
		if (card.decision) {
			for (const option of card.decision.options) {
				if (option.intent === "delegate") continue;
				add(option.id, option.label, {
					kind: "interaction",
					decision: {
						...base,
						responseKind: "answer",
						body: `${option.label}: ${option.consequence}`,
						resolvesRequest: option.intent !== "later",
						metadata: {
							source: "mcp-app",
							cardAction: option.id,
							decisionChoice: option.intent,
							decisionClass: card.decision.classId,
							feedbackSignal:
								option.intent === "approve" ? "approve-as-is" : "answer",
						},
					},
				});
			}
		} else if (offered?.decisionCard) {
			view.options = offered.decisionCard.options.map((option) => ({
				id: option.id,
				label: option.label,
				consequence: option.body ?? null,
			}));
			for (const option of offered.decisionCard.options)
				add(option.id, option.label, {
					kind: "interaction",
					decision: {
						...base,
						responseKind: "answer",
						body: option.body ?? option.label,
						resolvesRequest: true,
						metadata: { cardAction: option.id, source: "mcp-app" },
					},
				});
		} else {
			const responseKind =
				request.kind === "input"
					? "input_provided"
					: request.kind === "coordination"
						? "coordination_update"
						: "answer";
			view.options = (offered?.suggestedAnswers ?? []).map((label, index) => ({
				id: `answer-${index}`,
				label,
				consequence: null,
			}));
			for (const option of view.options)
				add(option.id, option.label, {
					kind: "interaction",
					decision: {
						...base,
						responseKind,
						body: option.label,
						resolvesRequest: true,
						metadata: { cardAction: "answer", source: "mcp-app" },
					},
				});
			add(
				"answer",
				"Send answer",
				{
					kind: "interaction",
					decision: { ...base, responseKind, body: "", resolvesRequest: true },
				},
				"/decision/body",
			);
		}
	} else if (card.factory) {
		for (const verdict of ["useful", "not_useful"])
			add(
				verdict,
				verdict === "useful" ? "Useful" : "Not useful",
				{
					kind: "factory",
					cardId: card.id,
					expectedRevision: card.factory.revision,
					verdict,
					reason: "",
				},
				"/reason",
			);
	}
	view.actions = view.actions.filter((action) => {
		const choice = action.arguments.decision;
		if (!isRecord(choice)) return false;
		if (choice.kind === "factory") return true;
		if (choice.kind !== "interaction" || !isRecord(choice.decision))
			return false;
		return !deckResponseRequiresHuman(
			card,
			typeof choice.decision.body === "string" ? choice.decision.body : "",
		);
	});
	view.needsText = view.actions.some((action) => action.textPath !== null);
	return view;
}

export function feedDisplayCard(
	item: z.infer<typeof ForYouProjectionSchema>["items"][number],
): AttentionDisplayCard {
	const personal = item.personalAgentContribution;
	const copy = checkedCopy(item.presentation);
	return {
		id: item.id,
		kind: item.kind,
		ask:
			copy?.title ??
			(item.needsAction
				? decisionCardFallbackTitle(item.sentence)
				: item.sentence),
		context: copy?.context ?? null,
		confidence: item.decision?.confidence ?? null,
		ifYes: copy?.body ?? (item.needsAction ? copySpec.pendingFace : null),
		why:
			copy?.recommendation ??
			(item.needsAction ? null : item.explanation || null),
		stakes: copy?.stakes ?? null,
		provenance: personal
			? `${personal.sourceAgentName} · personal agent`
			: item.actor,
		evidenceUrl: personal?.evidenceUrl ?? null,
		dueAt: item.dueAt,
		source: attentionSource(item.source),
		draft: item.decision?.preview?.body ?? null,
		recipient: null,
		subject: null,
		options: [],
		actions: [],
		answer: "",
		needsText: false,
		status: null,
	};
}

function askPrefix(card: AttentionDisplayCard) {
	const tags = [
		card.askLabel,
		card.overdue ? "Overdue" : null,
		card.handled ? "Handled" : null,
		card.expired ? "Expired" : null,
		card.draftedNotSent ? "Drafted, not sent" : null,
	].filter(Boolean);
	const due =
		card.dueAt && card.askLabel
			? ` · due ${card.dueAt.replace("T", " ").slice(0, 16)}`
			: "";
	return tags.length ? `[${tags.join(" · ")}${due}] ` : "";
}

export function attentionMarkdown(
	cards: AttentionDisplayCard[],
	complete: boolean,
): string {
	const lines = cards.map((card) =>
		[
			`- ${askPrefix(card)}${card.ask.replace(/[\[\]\r\n]/g, " ")}`,
			card.context && `  ${card.context}`,
			card.ifYes && `  If yes: ${card.ifYes}`,
			card.why && `  ${card.why}`,
			card.confidence != null && `  ${Math.round(card.confidence * 100)}% sure`,
			card.actions.length > 0 &&
				`  Choices: ${card.actions.map((action) => action.label).join(" / ")}`,
			`  Details: [Original request](${card.source})`,
		]
			.filter(Boolean)
			.join("\n"),
	);
	const stale = cards.filter((card) => card.draftedNotSent).length;
	return [
		...(complete
			? []
			: ["Some sources could not be read. Reload before deciding."]),
		...(stale
			? [
					`Drafted, not sent: ${stale} message draft${stale === 1 ? "" : "s"} waiting to be sent.`,
				]
			: []),
		...lines,
		...(cards.length
			? []
			: [
					complete
						? "Nothing needs your attention right now."
						: "No cards loaded; the inventory is incomplete.",
				]),
	].join("\n");
}
