import { createDbClient, type DbClient } from "@tedix/db/client";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import {
	getDeckSweepReceipt,
	listCardStatuses,
	listDeckSweepOrganizations,
	listDeckSweepRecipients,
	listRecipientCards,
	listWorkItemDispositions,
	recordDeckSweepReceipt,
	setDeckPipelineLearned,
} from "@tedix/db/queries/work-items/deck-sweep";
import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import type {
	DeckPipelineConfig,
	DeckPipelineMetrics,
	DeckSweepReceipt,
} from "@tedix/api-contract/schemas/deck-pipeline";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { deckAskKind } from "@tedix/api-contract/utils/deck-ask";
import {
	deckSourceKey,
	nextHidingClasses,
	planDeckSweep,
	type SweepAction,
	type SweepCard,
} from "@tedix/api-contract/utils/deck-pipeline";
import {
	deckInteractionKind,
	projectDeckCards,
} from "@tedix/api-contract/utils/deck-projection";
import { cardOriginalBody } from "../services/card-revisions";
import { appendCuration, criticalDeckRequest } from "../services/deck-curation";

type CardRow = Awaited<ReturnType<typeof listRecipientCards>>[number];
const SWEEP_ACTOR = { type: "system", id: "deck-pipeline" } as const;
const WEEK_MS = 7 * 86_400_000;

function isProtected(row: CardRow) {
	return (
		criticalDeckRequest(row as Parameters<typeof criticalDeckRequest>[0]) ||
		credentialCard(`${row.subject} ${row.prompt}`, row.metadata)
	);
}

export function sweepCard(
	row: CardRow,
	dispositions: ReadonlyMap<string, string>,
): SweepCard {
	const kind = deckInteractionKind(row.kind, row.metadata);
	return {
		id: row.id,
		kind,
		subject: row.subject,
		prompt: row.prompt,
		creatorType: row.creatorType,
		creatorId: row.creatorId,
		workItemId: row.workItemId,
		workItemDisposition: row.workItemId
			? (dispositions.get(row.workItemId) ?? null)
			: null,
		dueAt: row.dueAt,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		metadata: row.metadata,
		protected: isProtected(row),
		askKind: deckAskKind({
			kind,
			decision: DecisionEnvelopeSchema.safeParse(row.metadata.decisionDeck)
				.data,
			request: { metadata: row.metadata },
		}),
	};
}

/** Retire through the same immutable curation revision the retire verb writes. */
async function applyRetirement(
	db: DbClient,
	orgId: string,
	action: SweepAction,
) {
	const request = await getWorkInteraction(db, {
		orgId,
		interactionId: action.cardId,
	});
	if (!request || request.status !== "open") return false;
	const prior = DeckCurationStateSchema.safeParse(request.metadata.curation);
	await appendCuration(
		{ db },
		{
			orgId,
			actor: SWEEP_ACTOR,
			request,
			expectedRevision: Number(request.metadata.cardRevision ?? 0),
			body: cardOriginalBody(request),
			state: DeckCurationStateSchema.parse({
				schema: "tedix.deck-curation.v1",
				status: "cancelled",
				successorId: action.successorId ?? null,
				penalty: prior.success ? prior.data.penalty : 0,
				reason: action.note,
				evidenceRefs: action.evidenceRefs,
				model: prior.success ? prior.data.model : null,
				exampleIds: prior.success ? prior.data.exampleIds : [],
				retirement: {
					reason: action.reason,
					workItemId: action.workItemId ?? null,
				},
				...(prior.success && prior.data.shadow
					? { shadow: prior.data.shadow }
					: {}),
			}),
		},
	);
	return true;
}

/** Open interactions that the default Deck routing would show (Feed-routed ones excluded). */
export function deckCardCount(
	rows: readonly CardRow[],
	now: Date,
	timeZone: string,
) {
	try {
		return projectDeckCards({
			requests: rows.map((row) => ({
				request: {
					...row,
					requestedAt: row.createdAt,
					requestedFromType: "user",
					state: row.status,
				},
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				workItem: null,
				responseCount: 0,
			})) as unknown as Parameters<typeof projectDeckCards>[0]["requests"],
			work: [],
			runtime: [],
			now,
			timeZone,
		}).length;
	} catch {
		return rows.length;
	}
}

function localClock(now: Date, timeZone: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(now);
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? "00";
	return {
		date: `${get("year")}-${get("month")}-${get("day")}`,
		minutes: Number(get("hour")) * 60 + Number(get("minute")),
	};
}

/** S2 for one organization: bounded, index-backed reads, then retirements. */
export async function sweepOrganizationDeck(
	db: DbClient,
	orgId: string,
	now: Date,
	env?: CloudflareEnv,
) {
	const learning = await getDecisionLearningConfig(db, orgId);
	const config: DeckPipelineConfig = learning.deckPipeline;
	const mode = config.sweep.mode;
	const previous = await getDeckSweepReceipt(db, orgId);
	const receipt: DeckSweepReceipt = {
		at: now.toISOString(),
		mode,
		recipients: 0,
		retired: 0,
		merged: 0,
		proposed: 0,
		ranked: 0,
		hidden: 0,
		wouldRetire: 0,
		errors: 0,
		removed: [],
		metrics: [],
	};
	if (mode === "off") return receipt;
	const statuses = await listCardStatuses(
		db,
		orgId,
		(previous?.removed ?? []).map((entry) => entry.id),
	);
	const members = await listDeckSweepRecipients(
		db,
		orgId,
		config.sweep.maxRecipients,
	);
	const clock = localClock(now, learning.timezone);
	let budget = config.sweep.maxRetirementsPerRun;
	let hidingClasses = config.hidingClasses;
	let rankBudget = config.secondKey.maxPerRun;
	for (const { recipientIds } of members) {
		for (const recipientId of recipientIds) {
			const open = await listRecipientCards(db, {
				orgId,
				recipientId,
				status: "open",
				limit: config.sweep.maxCardsPerRecipient,
			});
			if (!open.length) continue;
			receipt.recipients += 1;
			const dispositions = await listWorkItemDispositions(
				db,
				orgId,
				open.flatMap((row) => (row.workItemId ? [row.workItemId] : [])),
			);
			const resolved = await listRecipientCards(db, {
				orgId,
				recipientId,
				status: "resolved",
				limit: 100,
			});
			const cancelled = await listRecipientCards(db, {
				orgId,
				recipientId,
				status: "cancelled",
				limit: 100,
			});
			// A request past its own expiry is already off the Deck (effective state "expired").
			const live = open.filter(
				(row) => !(row.expiresAt && row.expiresAt <= now.toISOString()),
			);
			const cards = live.map((row) => sweepCard(row, dispositions));
			const plan = planDeckSweep({
				cards,
				now,
				config: { ...config.sweep, maxRetirementsPerRun: budget },
				rules: config.rules.filter((rule) => rule.recipientId === recipientId),
				answered: resolved.map((row) => ({
					id: row.id,
					sourceKey: deckSourceKey(row),
					subject: row.subject,
				})),
			});
			receipt.proposed += plan.proposals.length;
			let retiredHere = 0;
			for (const action of plan.actions) {
				if (mode === "shadow") {
					receipt.wouldRetire += 1;
					continue;
				}
				try {
					if (await applyRetirement(db, orgId, action)) {
						retiredHere += 1;
						if (action.cause === "duplicate") receipt.merged += 1;
						else receipt.retired += 1;
						receipt.removed.push({
							id: action.cardId,
							recipientId,
							protected:
								cards.find((card) => card.id === action.cardId)?.protected ??
								false,
						});
					}
				} catch (error) {
					receipt.errors += 1;
					console.warn("deck sweep retirement skipped", {
						orgId,
						cardId: action.cardId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			budget = Math.max(0, budget - retiredHere);
			const retiredIds = new Set(receipt.removed.map((entry) => entry.id));
			const remaining = cards.filter((card) => !retiredIds.has(card.id));
			// Earned hiding: per (ask kind x source) class, measured on shadow labels.
			const shadowOf = (row: CardRow) =>
				DeckCurationStateSchema.safeParse(row.metadata.curation).data?.shadow;
			const swipes = [
				...resolved.flatMap((row) => {
					const shadow = shadowOf(row);
					return shadow
						? [
								{
									classKey: shadow.classKey,
									valuable: true,
									wouldHide: shadow.wouldHide,
								},
							]
						: [];
				}),
				...cancelled.flatMap((row) => {
					const state = DeckCurationStateSchema.safeParse(
						row.metadata.curation,
					).data;
					return state?.notUseful && state.shadow
						? [
								{
									classKey: state.shadow.classKey,
									valuable: false,
									wouldHide: state.shadow.wouldHide,
								},
							]
						: [];
				}),
			];
			const hideStatuses = await listCardStatuses(
				db,
				orgId,
				hidingClasses
					.filter((entry) => entry.recipientId === recipientId)
					.flatMap((entry) => entry.recentHides),
			);
			const nextClasses = nextHidingClasses({
				recipientId,
				classes: hidingClasses,
				swipes,
				undone: new Set(
					[...hideStatuses].flatMap(([id, state]) =>
						state === "open" ? [id] : [],
					),
				),
				config: config.earnedHiding,
				now,
			});
			for (const card of remaining) {
				const shadow = DeckCurationStateSchema.safeParse(card.metadata.curation)
					.data?.shadow;
				const entry = nextClasses.find(
					(item) =>
						item.recipientId === recipientId &&
						item.classKey === shadow?.classKey &&
						item.state === "hiding",
				);
				if (
					!shadow?.wouldHide ||
					!entry ||
					card.protected ||
					mode !== "enforce"
				)
					continue;
				try {
					if (
						await applyRetirement(db, orgId, {
							cardId: card.id,
							reason: "no_longer_relevant",
							cause: "rule",
							note: "Hidden: the ranker and its second key both judged it not worth your minute, and this kind of card has earned hiding. Undo puts it back.",
							evidenceRefs: [`deck-hiding:${entry.classKey}`],
						})
					) {
						receipt.hidden += 1;
						retiredHere += 1;
						entry.recentHides = [...entry.recentHides, card.id].slice(-50);
						receipt.removed.push({
							id: card.id,
							recipientId,
							protected: false,
						});
					}
				} catch {
					receipt.errors += 1;
				}
			}
			hidingClasses = nextClasses;
			if (env && rankBudget > 0 && mode === "enforce") {
				const { deckRankPool, shadowRankDeck } =
					await import("./deck-shadow-rank");
				const supplied = learning.deckCurators
					.filter((grant) => grant.enabled && grant.recipientId === recipientId)
					.flatMap((grant) => grant.examples);
				const ranked = await shadowRankDeck({
					db,
					env,
					orgId,
					learning,
					cards: remaining.filter(
						(card) => !receipt.removed.some((r) => r.id === card.id),
					),
					pool: await deckRankPool(db, orgId, recipientIds, supplied),
					now,
					limit: rankBudget,
				});
				receipt.ranked += ranked.ranked;
				rankBudget -= ranked.ranked;
			}
			const weekAgo = now.getTime() - WEEK_MS;
			const notUseful = cancelled.filter(
				(row) =>
					Date.parse(row.cancelledAt ?? "") >= weekAgo &&
					DeckCurationStateSchema.safeParse(row.metadata.curation).data
						?.notUseful,
			).length;
			const removedBefore = (previous?.removed ?? []).filter(
				(entry) => entry.recipientId === recipientId,
			);
			const undone = removedBefore.filter(
				(entry) => statuses.get(entry.id) === "open",
			);
			const prior = previous?.metrics.find(
				(entry) => entry.recipientId === recipientId,
			);
			const liveCards = deckCardCount(
				live.filter(
					(row) => !receipt.removed.some((entry) => entry.id === row.id),
				),
				now,
				learning.timezone,
			);
			const metrics: DeckPipelineMetrics = {
				recipientId,
				liveCards,
				morning:
					clock.minutes >= 8 * 60 + 30 &&
					clock.minutes < 10 * 60 &&
					prior?.morning?.date !== clock.date
						? { date: clock.date, liveCards }
						: (prior?.morning ?? null),
				notUseful,
				settled:
					resolved.filter((row) => Date.parse(row.resolvedAt ?? "") >= weekAgo)
						.length + notUseful,
				wrongRemovals: (prior?.wrongRemovals ?? 0) + undone.length,
				wrongProtectedRemovals:
					(prior?.wrongProtectedRemovals ?? 0) +
					undone.filter((entry) => entry.protected).length,
				removals: (prior?.removals ?? 0) + retiredHere,
			};
			receipt.metrics.push(metrics);
			// Keep watching recent removals that were not undone yet.
			receipt.removed.push(
				...removedBefore.filter(
					(entry) => statuses.get(entry.id) === "cancelled",
				),
			);
		}
	}
	if (JSON.stringify(hidingClasses) !== JSON.stringify(config.hidingClasses))
		await setDeckPipelineLearned(db, orgId, {
			rules: config.rules,
			hidingClasses,
		});
	receipt.removed = receipt.removed.slice(-200);
	receipt.metrics = receipt.metrics.slice(0, 50);
	await recordDeckSweepReceipt(db, orgId, receipt);
	return receipt;
}

/** Every-15-minute tick: bounded organizations, recipients and cards. */
export async function sweepDeckPipeline(
	env: CloudflareEnv,
	scheduledTime = Date.now(),
): Promise<Record<string, number>> {
	const db = createDbClient(env.DB);
	const now = new Date(scheduledTime);
	const totals = { organizations: 0, retired: 0, merged: 0, errors: 0 };
	for (const orgId of await listDeckSweepOrganizations(db)) {
		try {
			const receipt = await sweepOrganizationDeck(db, orgId, now, env);
			totals.organizations += 1;
			totals.retired += receipt.retired;
			totals.merged += receipt.merged;
			totals.errors += receipt.errors;
		} catch (error) {
			totals.errors += 1;
			console.error("deck sweep failed", {
				orgId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return totals;
}
