/**
 * Tell owners and admins when a credit budget reaches 80% or 100% of its
 * limit: one Deck card each, once per limit. A used-up stop budget's card
 * offers to double the limit; approving it runs the `raise_budget_limit`
 * decision effect.
 *
 * The organization wallet notices the crossing while it charges and calls
 * this from its alarm, so a retry after a lost result finds the alert already
 * recorded on the envelope and the cards already created under fixed ids.
 */

import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { projects as d1Projects } from "../../schema/projects";
import { tediObjectives as d1TediObjectives } from "../../schema/tedi-objectives";
import {
	workCases as d1WorkCases,
	type WorkBudgetEnvelope,
} from "../../schema/work-factory";
import { workItems as d1WorkItems } from "../../schema/work-items";
import {
	creditNoticeCardId,
	listCreditNoticeRecipients,
	noticeProjectId,
} from "../billing/credit-notice-deliveries";
import {
	CREDIT_BUDGET_ALERT_CARD_SCHEMA,
	getWorkBudgetEnvelopeById,
	markCreditBudgetAlerted,
} from "./budgets";
import { createWorkInteraction, getWorkInteraction } from "./interactions";

const CARD_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MICROS_PER_CREDIT = 1_000_000;

export interface CreditBudgetAlert {
	orgId: string;
	envelopeId: string;
	/** The limit the crossing was measured against. */
	limitMicros: number;
	percent: 80 | 100;
	/** Millionths of a credit spent when the crossing was seen. */
	spentMicros: number;
	/** The Work whose spend crossed it; the card is filed there. */
	workItemId: string | null;
	now: string;
}

function credits(micros: number): string {
	return (micros / MICROS_PER_CREDIT).toLocaleString("en-US", {
		maximumFractionDigits: micros < 10 * MICROS_PER_CREDIT ? 2 : 0,
	});
}

async function scopeName(
	db: DbQueryClient,
	envelope: WorkBudgetEnvelope,
): Promise<string> {
	const { orgId, scopeId } = envelope;
	const workItems = coreTable(db, d1WorkItems);
	const projects = coreTable(db, d1Projects);
	const workCases = coreTable(db, d1WorkCases);
	const tediObjectives = coreTable(db, d1TediObjectives);
	const named = async (rows: Promise<Array<{ name: string }>>, kind: string) =>
		`${kind} “${(await rows)[0]?.name ?? scopeId}”`;
	switch (envelope.scopeType) {
		case "organization":
			return "Your organization";
		case "work_item":
			return named(
				db
					.select({ name: workItems.title })
					.from(workItems)
					.where(and(eq(workItems.orgId, orgId), eq(workItems.id, scopeId)))
					.limit(1),
				"Work",
			);
		case "project":
			return named(
				db
					.select({ name: projects.name })
					.from(projects)
					.where(and(eq(projects.orgId, orgId), eq(projects.id, scopeId)))
					.limit(1),
				"Project",
			);
		case "case":
			return named(
				db
					.select({ name: workCases.title })
					.from(workCases)
					.where(and(eq(workCases.orgId, orgId), eq(workCases.id, scopeId)))
					.limit(1),
				"Case",
			);
		case "objective":
			return named(
				db
					.select({ name: tediObjectives.title })
					.from(tediObjectives)
					.where(
						and(
							eq(tediObjectives.orgId, orgId),
							eq(tediObjectives.id, scopeId),
						),
					)
					.limit(1),
				"Goal",
			);
	}
}

function alertDecision(
	envelope: WorkBudgetEnvelope,
	alert: CreditBudgetAlert,
	name: string,
) {
	const limit = credits(alert.limitMicros);
	const spent = credits(alert.spentMicros);
	const stopped = alert.percent === 100 && envelope.mode === "stop";
	const subject =
		alert.percent === 80
			? `${name} has used 80% of its ${limit}-credit budget`
			: stopped
				? `${name} has used its ${limit}-credit budget and stopped`
				: `${name} has used its ${limit}-credit budget`;
	const story = `${spent} of ${limit} credits are spent. ${
		envelope.mode === "alert"
			? "This budget only sends notices, so tedis, code runs and agents keep spending."
			: stopped
				? "Tedis, code runs and agents working on it can't spend more credits, and new tasks under it wait, until someone raises the limit."
				: "At 100%, tedis, code runs and agents working on it stop spending until someone raises the limit."
	}`;
	const raised = alert.limitMicros * 2;
	const options = stopped
		? [
				{
					id: "raise",
					label: `Raise to ${credits(raised)} credits`,
					intent: "approve" as const,
					consequence: `Sets the limit to ${credits(raised)} credits. Spending resumes within a minute.`,
					cost: `Up to ${credits(raised - alert.limitMicros)} more credits`,
					effect: {
						kind: "raise_budget_limit" as const,
						envelopeId: envelope.id,
						expectedLimitMicros: alert.limitMicros,
						limitMicros: raised,
					},
				},
				{
					id: "keep",
					label: "Keep it stopped",
					intent: "reject" as const,
					consequence:
						"Nothing changes. You can raise the limit later under Work › Capacity.",
					cost: "None",
				},
			]
		: [
				{
					id: "seen",
					label: "Got it",
					intent: "approve" as const,
					consequence: "Closes this card. Nothing changes.",
					cost: "None",
				},
				{
					id: "later",
					label: "Later",
					intent: "later" as const,
					consequence: "Keeps this card open.",
					cost: "None",
				},
			];
	return {
		subject,
		story,
		decision: DecisionEnvelopeSchema.parse({
			version: 1,
			kind: "decision",
			classId: "work.credit_budget_alert",
			proposal: subject,
			whyNow: story,
			recommendation: stopped
				? `Raise the limit to ${credits(raised)} credits if this Work should go on.`
				: "No action is needed now.",
			reversibility: "two_way",
			tasteOrStrategy: true,
			// No protected effect: that would refuse the raise after any new
			// Work comment. The effect is fenced on the limit instead.
			protectedEffects: [],
			blastRadius: `${name}: its tedis, code runs and agents`,
			confidence: null,
			costOfWaiting: stopped
				? "The Work stays stopped until the limit is raised."
				: envelope.mode === "alert"
					? "None; spending continues."
					: "None until the budget is used up.",
			reasoning: story,
			informational: !stopped,
			options,
		}),
	};
}

/**
 * Record the alert on the envelope and put a card on each owner's and admin's
 * Deck. Returns how many cards exist for it; 0 when it was already recorded
 * for this limit, the limit changed since, or the budget is gone.
 */
export async function deliverCreditBudgetAlert(
	db: DbQueryClient,
	alert: CreditBudgetAlert,
): Promise<number> {
	const marked = await markCreditBudgetAlerted(db, alert);
	// A retry after the mark but before every card: finish the cards.
	const current = marked ? null : await getWorkBudgetEnvelopeById(db, alert);
	const envelope =
		marked ??
		(current?.limitMicros === alert.limitMicros &&
		current.alertedPercent === alert.percent
			? current
			: null);
	if (!envelope) return 0;
	const [recipients, name] = await Promise.all([
		listCreditNoticeRecipients(db, alert.orgId),
		scopeName(db, envelope),
	]);
	// Filed on the project, not the Work: the budget outlives the Work, and an
	// ended Attempt or finished Work must not withdraw the raise card.
	const workItems = coreTable(db, d1WorkItems);
	const [work] = alert.workItemId
		? await db
				.select({ projectId: workItems.projectId })
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, alert.orgId),
						eq(workItems.id, alert.workItemId),
					),
				)
				.limit(1)
		: [];
	const projectId =
		envelope.scopeType === "project"
			? envelope.scopeId
			: (work?.projectId ?? (await noticeProjectId(db, alert.orgId)));
	if (!projectId) return 0;
	const { subject, story, decision } = alertDecision(envelope, alert, name);
	const expiresAt = new Date(Date.parse(alert.now) + CARD_TTL_MS).toISOString();
	let cards = 0;
	for (const recipient of recipients) {
		const id = await creditNoticeCardId(
			`credit-budget-alert:${envelope.id}:${alert.limitMicros}:${alert.percent}:${recipient.userId}`,
		);
		if (
			!(await getWorkInteraction(db, { orgId: alert.orgId, interactionId: id }))
		)
			try {
				await createWorkInteraction(db, {
					id,
					orgId: alert.orgId,
					projectId,
					kind: "question",
					subject,
					prompt: story,
					creator: { type: "system", id: "tedix" },
					targetType: "user",
					targetId: recipient.userId,
					expiresAt,
					metadata: {
						schema: CREDIT_BUDGET_ALERT_CARD_SCHEMA,
						envelopeId: envelope.id,
						limitMicros: alert.limitMicros,
						workItemId: alert.workItemId,
						percent: alert.percent,
						triage: { status: "ok", urgency: "now" },
						decisionDeck: decision,
					},
					now: alert.now,
				});
			} catch (error) {
				if (
					!(await getWorkInteraction(db, {
						orgId: alert.orgId,
						interactionId: id,
					}))
				)
					throw error;
			}
		cards++;
	}
	return cards;
}
