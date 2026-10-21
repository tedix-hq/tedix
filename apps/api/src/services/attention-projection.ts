import { timelineItems } from "@tedix/api-contract/utils/feed-story";
import { factoryCardScore } from "@tedix/api-contract/utils/card-priority";
import { call } from "@orpc/server";
import type * as z from "zod";
import {
	AttentionViewInputSchema,
	type DeckCard,
} from "@tedix/api-contract/schemas/attention";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	ActivityFeedConfigSchema,
	type ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import {
	projectDeckCards,
	annotateDeckAsk,
	compareDecisionFreshness,
	rankDeckCard,
} from "@tedix/api-contract/utils/deck-projection";
import {
	cardIsDue,
	factoryCardDeadline,
} from "@tedix/api-contract/utils/card-schedule";
import {
	cardSheetsForSource,
	cardsFromSheet,
	factoryLearningClass,
	isOpen,
	routeFactoryCard,
	scoredCards,
	type ReviewCard,
} from "@tedix/api-contract/utils/card-review";
import {
	workFeedItems,
	resultFeedItems,
	correctionFeedItems,
	decisionFeedItems,
	approvalFeedItems,
	retiredDeckFeedItems,
	deckPipelineFeedItems,
	sentence,
} from "@tedix/api-contract/utils/activity-feed";
import {
	rankFocusFeed,
	focusSelection,
	FOCUS_HISTORY_SURFACES,
} from "@tedix/api-contract/utils/focus-feed";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import { workInteractionsContractRouter } from "../rpc/routers/work-interactions";
import { workApprovalsContractRouter } from "../rpc/routers/work-approvals";
import { tediApprovalsContractRouter } from "../rpc/routers/tedi-approvals";
import { learningFeedbackContractRouter } from "../rpc/routers/learning-feedback";
import { osWorkspacesContractRouter } from "../rpc/routers/os-workspaces";
import { userSettingsContractRouter } from "../rpc/routers/user-settings";
import { workItemsContractRouter } from "../rpc/routers/work-items";
import { internalDecisionFeed } from "./internal-decision-feed";
import { requireOrgId } from "../rpc/org-scope";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { deckQualificationGraph } from "./deck-qualification-graph";
import { listDeckSourceStates } from "@tedix/db/queries/work-items/deck-sweep";
import { deckCardStale } from "@tedix/api-contract/utils/deck-ask";

type ViewInput = z.infer<typeof AttentionViewInputSchema>;

async function appManifest(
	context: BaseContext,
	role: "deck" | "feed",
	gadgetId?: string,
) {
	const apps = await call(
		osWorkspacesContractRouter.gadgets.workApps,
		{ limit: 200 },
		{ context },
	);
	if (apps.truncated)
		throw createError(ErrorCodes.CONFLICT, "Work app inventory is incomplete");
	const candidates = apps.items.filter(
		({ gadget, currentRevision: { manifest } }) =>
			(!gadgetId || gadget.id === gadgetId) &&
			(manifest.navigation?.work === role ||
				(manifest.navigation?.board &&
					manifest.entry ===
						(role === "deck"
							? "tedix:app/decision-deck"
							: "tedix:app/activity-feed"))),
	);
	if (candidates.length !== 1)
		throw createError(
			candidates.length ? ErrorCodes.CONFLICT : ErrorCodes.NOT_FOUND,
			candidates.length
				? "Choose a Work app with gadgetId"
				: "No visible Work app has that role",
		);
	return candidates[0]!.currentRevision.manifest;
}

async function factoryCards(
	context: BaseContext,
	sources: z.infer<typeof DecisionDeckConfigSchema>["factorySources"],
	now: Date,
	timeZone: string,
) {
	if (!sources.length)
		return {
			cards: [] as Array<{ card: ReviewCard; revision: number }>,
			complete: true,
		};
	const spaces = await call(
		osWorkspacesContractRouter.workspaces.list,
		{ status: "active", limit: 200 },
		{ context },
	);
	// Match useVisibleCardSources: shared apps may bind other people's workspaces.
	// The caller's active, authorized workspace inventory defines which bindings apply.
	const visible = new Set(spaces.items.map((space) => space.id));
	let complete = !spaces.truncated;
	const groups = await Promise.all(
		sources
			.filter((source) => visible.has(source.workspaceId))
			.map(async (source) => {
				const outputs = await call(
					osWorkspacesContractRouter.outputs.list,
					{ workspaceId: source.workspaceId, limit: 200 },
					{ context },
				);
				complete &&= !outputs.truncated;
				const sheets = cardSheetsForSource(source, outputs.items);
				return (
					await Promise.all(
						sheets.map(async (sheet) => {
							const detail = await call(
								osWorkspacesContractRouter.outputs.get,
								{ outputId: sheet.id },
								{ context },
							);
							const body = detail.currentRevision.content;
							if (body.kind !== "sheet")
								throw createError(
									ErrorCodes.CONFLICT,
									"Configured card output is not a sheet",
								);
							const parsed = cardsFromSheet({
								source,
								sourceIndex: sources.indexOf(source),
								outputId: sheet.id,
								sheetTitle: sheet.title,
								runCreatedAt: sheet.createdAt,
								body,
							});
							if ("missing" in parsed)
								throw createError(
									ErrorCodes.CONFLICT,
									"Configured card columns are missing",
								);
							return parsed.cards
								.filter((card) => cardIsDue(card, now, timeZone))
								.map((card) => ({
									card,
									revision: detail.currentRevision.revision,
								}));
						}),
					)
				).flat();
			}),
	);
	const loaded = groups.flat();
	const kept = new Set(
		scoredCards(
			loaded.map((entry) => entry.card),
			sources,
			now,
		),
	);
	return { cards: loaded.filter((entry) => kept.has(entry.card)), complete };
}

export async function loadDeckProjection(
	context: BaseContext,
	input: ViewInput,
) {
	const manifest = await appManifest(context, "deck", input.gadgetId);
	return loadConfiguredDeckProjection(
		context,
		input,
		DecisionDeckConfigSchema.parse(manifest.config),
	);
}

async function loadConfiguredDeckProjection(
	context: BaseContext,
	input: ViewInput,
	config: z.infer<typeof DecisionDeckConfigSchema>,
	destination: "deck" | "all" = "deck",
) {
	const preferences = await call(
		userSettingsContractRouter.getPreferences,
		{},
		{ context },
	);
	const timeZone = input.timeZone ?? preferences.preferences.timezone ?? "UTC";
	const projectId = input.projectId ?? config.projectId;
	const now = new Date();
	const qualification = (
		await getDecisionLearningConfig(context.db, requireOrgId(context))
	).deckPipeline.qualification;
	const [model, first, work, runtime, factories] = await Promise.all([
		call(learningFeedbackContractRouter.model, {}, { context }),
		call(
			workInteractionsContractRouter.listInbox,
			{ projectId, limit: config.limit, states: ["open"] },
			{ context },
		),
		call(
			workApprovalsContractRouter.listInbox,
			{ projectId, limit: config.limit, statuses: ["pending"] },
			{ context },
		),
		projectId
			? Promise.resolve(null)
			: call(
					tediApprovalsContractRouter.list,
					{ status: "pending", decidableOnly: true },
					{ context },
				),
		factoryCards(context, config.factorySources, now, timeZone),
	]);
	const requests = [...first.data];
	let cursor = first.nextCursor;
	// Read every bounded page; expose incompleteness if the safety ceiling is reached.
	for (let page = 1; cursor && page < 100; page++) {
		const next = await call(
			workInteractionsContractRouter.listInbox,
			{ projectId, limit: config.limit, states: ["open"], cursor },
			{ context },
		);
		requests.push(...next.data);
		cursor = next.nextCursor;
	}
	const cards = projectDeckCards({
		requests,
		work: work.data,
		runtime: runtime?.data ?? [],
		model,
		now,
		timeZone,
		routing: config.routing,
		destination,
		staleDraftHours: config.staleDraftHours,
	});
	for (const { card, revision } of factories.cards) {
		if (!isOpen(card)) continue;
		const route = routeFactoryCard(card, config.routing, now, model);
		if (route.destination !== "deck") continue;
		const project =
			config.factorySources[card.sourceIndex]?.run?.workProjectId ?? "Unfiled";
		cards.push({
			id: `factory:${card.key}`,
			kind: "decision",
			label: card.action || card.why || card.sourceText,
			project,
			urgency: "later",
			decision: null,
			source: `/work?view=deck#card=factory:${card.key}`,
			requestedAt: card.runCreatedAt,
			dueAt: factoryCardDeadline(card),
			score: 0,
			factory: {
				outputId: card.outputId,
				sourceIndex: card.sourceIndex,
				rowIndex: card.rowIndex,
				revision,
				policyCritical: route.reason === "critical",
				score: factoryCardScore(card),
				draft: card.draft,
				why: card.why,
				sourceText: card.sourceText,
			},
		});
	}
	for (const card of cards)
		card.score = rankDeckCard(
			card,
			model,
			now,
			card.interaction?.request,
		).score;
	annotateDeckAsk(cards, now, {
		timeZone,
		staleDraftHours: config.staleDraftHours,
		qualification,
	});
	if (qualification.enabled) {
		const { createDecisionGraphReader } =
			await import("./decision-graph-reads");
		const graph = await deckQualificationGraph(
			context.db,
			requireOrgId(context),
			cards.map((card) => ({
				id: card.id,
				workItemId: card.interaction?.request.workItemId,
			})),
			createDecisionGraphReader(context.env),
		);
		const sourceWork = new Map(
			cards.map((card) => [
				card.id,
				card.interaction?.request.workItemId ??
					graph
						.get(card.id)
						?.chain.find((step) => step.edge.kind === "card_from_work")?.node
						.id,
			]),
		);
		const states = await listDeckSourceStates(
			context.db,
			requireOrgId(context),
			[...sourceWork.values()].filter((id): id is string => Boolean(id)),
			now,
		);
		for (const card of cards) {
			const facts = graph.get(card.id);
			const workId = sourceWork.get(card.id);
			const stale = deckCardStale(
				{
					...card,
					request: card.interaction?.request,
					workItem: { disposition: workId ? states.get(workId) : undefined },
				},
				now,
				qualification,
				timeZone,
			);
			if (
				stale ||
				(qualification.alreadyDecided &&
					facts?.priorDecision &&
					card.responseKind !== "task") ||
				(qualification.graphDuplicates && facts?.supersededBy)
			) {
				card.actionable = false;
				card.overdue = false;
			}
			if (qualification.rankBlocked) {
				card.blocksCount = facts?.blocksCount ?? 0;
				if (facts?.blocksReach !== undefined)
					card.blocksScore = facts.blocksReach;
			}
		}
	}
	cards.sort((a, b) => compareDecisionFreshness(a, b, now, timeZone));
	return {
		cards,
		count: cards.length,
		complete:
			!cursor &&
			!work.hasMore &&
			!runtime?.pagination.hasMore &&
			factories.complete,
		observedAt: now.toISOString(),
		model,
		config,
	};
}

/** Ranking and budget selection are the same pure functions used in the browser. Reads never log impressions. */
export async function loadForYouProjection(
	context: BaseContext,
	input: ViewInput,
) {
	const manifest = await appManifest(context, "feed", input.gadgetId);
	const config = ActivityFeedConfigSchema.parse(manifest.config);
	const preferenceState = await call(
		userSettingsContractRouter.getPreferences,
		{},
		{ context },
	);
	const timeZone =
		input.timeZone ?? preferenceState.preferences.timezone ?? "UTC";
	const now = new Date();
	const projectIds = config.projects
		.filter((p) => !input.projectId || p.id === input.projectId)
		.map((p) => p.id);
	const sourceIds = [
		...new Set([
			...(config.scope === "organization" ? [input.projectId] : []),
			...projectIds,
		]),
	];
	const [
		deck,
		preferences,
		history,
		sourcePages,
		factories,
		today,
		handledInternal,
		pipeline,
		retired,
	] = await Promise.all([
		loadConfiguredDeckProjection(
			context,
			{ ...input, limit: 100 },
			DecisionDeckConfigSchema.parse({
				version: 1,
				projectId: input.projectId,
			}),
			"all",
		),
		Promise.resolve(preferenceState),
		call(
			learningFeedbackContractRouter.listInteractions,
			{ scopeKind: "personal", limit: 200, surfaces: FOCUS_HISTORY_SURFACES },
			{ context },
		),
		Promise.all(
			sourceIds.map(async (projectId) => {
				const [activity, attempts] = await Promise.all([
					call(
						workItemsContractRouter.listActivity,
						{ projectId, limit: config.pageSize },
						{ context },
					),
					call(
						workItemsContractRouter.listAttemptProjection,
						{
							projectId,
							limit: config.pageSize,
							outcomes: ["succeeded", "failed", "expired", "cancelled"],
						},
						{ context },
					),
				]);
				return {
					items: [
						...workFeedItems(activity.events, projectId ?? null),
						...resultFeedItems(attempts.data),
					],
					complete: !activity.truncated && !attempts.hasMore,
				};
			}),
		),
		factoryCards(
			context,
			config.factorySources.map((binding) => binding.source),
			now,
			timeZone,
		),
		config.today
			? call(
					osWorkspacesContractRouter.outputs.get,
					{ outputId: config.today.outputId },
					{ context },
				)
			: Promise.resolve(null),
		internalDecisionFeed(context, requireOrgId(context), input.projectId),
		import("./deck-pipeline-status").then(({ loadDeckPipelineStatus }) =>
			import("@tedix/db/queries/decision-learning")
				.then(({ getDecisionLearningConfig }) =>
					getDecisionLearningConfig(context.db, requireOrgId(context)),
				)
				.then((config) => loadDeckPipelineStatus(context, config, now))
				.catch(() => undefined),
		),
		call(
			workInteractionsContractRouter.listInbox,
			{ projectId: input.projectId, limit: 100, states: ["cancelled"] },
			{ context },
		),
	]);
	const items: ActivityFeedItem[] = [
		...handledInternal.filter(
			(item) =>
				config.scope === "organization" ||
				(item.projectId !== null && projectIds.includes(item.projectId)),
		),
		...sourcePages.flatMap((page) => page.items),
		...correctionFeedItems(history.events),
		...retiredDeckFeedItems(retired.data, now),
		...deckPipelineFeedItems(pipeline, now),
		...decisionFeedItems(
			deck.cards.flatMap((card) =>
				card.interaction ? [card.interaction] : [],
			),
			now,
			timeZone,
		),
		...approvalFeedItems(
			deck.cards.flatMap((card) =>
				card.workApproval ? [card.workApproval] : [],
			),
			now,
			timeZone,
		).map((item) => ({
			...item,
			id: item.id.replace(/^approval:/, "work-approval:"),
		})),
		...deck.cards.flatMap((card) =>
			card.runtimeApproval
				? [
						{
							id: card.id,
							actor: "Tedix",
							sentence:
								card.runtimeApproval.review.operatorQuestion ||
								card.runtimeApproval.description,
							source: card.source,
							projectId: null,
							workItemId: null,
							tediId: card.runtimeApproval.tediId,
							kind: "approval" as const,
							classId: `approval:${card.runtimeApproval.actionType}`.slice(
								0,
								100,
							),
							importance: "high" as const,
							at: card.runtimeApproval.createdAt,
							dueAt: card.runtimeApproval.expiresAt,
							needsAction: true,
							stalled: false,
							done: false,
							explanation: card.runtimeApproval.description,
							reactions: [],
						},
					]
				: [],
		),
	];
	if (today?.currentRevision.content.kind === "document") {
		const table = today.currentRevision.content.blocks.find(
			(block) =>
				block.type === "table" &&
				block.headers.join("|") === "Project|Receipt|Summary|Source|Time",
		);
		if (table?.type === "table")
			for (const [projectId, id, text, source, at] of table.rows) {
				if (
					!projectId ||
					!id ||
					!text ||
					!source?.startsWith("/outputs/") ||
					!at ||
					!Number.isFinite(Date.parse(at))
				)
					continue;
				items.push({
					id: `today-document:${id}`,
					projectId,
					sentence: text,
					source,
					at,
					actor: "Tedix",
					workItemId: null,
					tediId: null,
					kind: "result",
					classId: "document_updated",
					importance: "normal",
					dueAt: null,
					needsAction: false,
					stalled: false,
					done: true,
					explanation: "A saved document was updated today.",
					reactions: [],
				});
			}
	}
	const faceSources = new Map(deck.cards.map((card) => [card.id, card]));
	for (const { card, revision } of factories.cards) {
		const binding = config.factorySources[card.sourceIndex]!;
		faceSources.set(`factory:${card.outputId}:${card.rowIndex}`, {
			id: `factory:${card.outputId}:${card.rowIndex}`,
			kind: "decision",
			label: card.action || card.why,
			project: binding.projectId,
			urgency: "later",
			decision: null,
			source: `/outputs/${card.outputId}`,
			requestedAt: card.runCreatedAt,
			dueAt: null,
			score: 0,
			factory: {
				outputId: card.outputId,
				sourceIndex: card.sourceIndex,
				rowIndex: card.rowIndex,
				revision,
				draft: card.draft,
				why: card.why,
				sourceText: card.sourceText,
			},
		});
		items.push({
			id: `factory:${card.outputId}:${card.rowIndex}`,
			actor: binding.source.label,
			sentence: sentence(
				card.result ||
					`${card.who ? `${card.who}: ` : ""}${card.why || card.sourceText}`,
			),
			source: `/workspace/${binding.source.workspaceId}?workpiece=output:${card.outputId}&pane=workpiece`,
			projectId: binding.projectId,
			workItemId: null,
			tediId: null,
			kind: isOpen(card) ? "decision" : "result",
			attachment: { title: card.sheetTitle },
			classId: factoryLearningClass(binding.source.label, card.type),
			importance: "normal",
			at: card.runCreatedAt,
			dueAt: null,
			needsAction: isOpen(card),
			stalled: /^failed/i.test(card.result),
			done: !isOpen(card),
			explanation: `${card.why}\n${card.sourceText}\nOutput ${card.outputId}, revision ${revision}, row ${card.rowIndex + 1}`,
			reactions: ["more", "why", "mute", "comment", "work"],
		});
	}
	const prefs = preferences.preferences.activityFeed ?? {
		projectIds: [],
		mutedClasses: [],
		preferredClasses: [],
		lastSeenAt: null,
	};
	const all = items.filter(
		(item) => !input.projectId || item.projectId === input.projectId,
	);
	const rankable = all.filter(
		(item) =>
			item.kind !== "work" ||
			item.classId !== "work:work.completed" ||
			!item.done ||
			!all.some(
				(receipt) =>
					receipt.kind === "result" &&
					receipt.done &&
					receipt.workItemId === item.workItemId,
			),
	);
	const ranked = rankFocusFeed(
		rankable,
		config,
		prefs,
		now,
		deck.model,
		history.events,
	);
	const selection = focusSelection(
		ranked,
		history.events,
		now,
		deck.model,
		!!config.today,
		prefs,
	);
	const outcomes = new Set(timelineItems(ranked).map((item) => item.id));
	const shown = [
		...selection.needs,
		...selection.updates.filter((item) => outcomes.has(item.id)),
	];
	const shownIds = new Set(shown.map((item) => item.id));
	const { prepareDeckCardFace, displayDeckCard } =
		await import("./deck-card-face");
	const pending: DeckCard[] = [];
	const visible = await Promise.all(
		shown.slice(0, input.limit).map(async (item) => {
			const card = faceSources.get(item.id.replace(/^decision:/, ""));
			if (!item.needsAction || !card) return item;
			const presentation = await prepareDeckCardFace(
				context,
				card,
				false,
				deck.model,
			);
			if (!presentation) pending.push(card);
			const display = displayDeckCard(card, presentation);
			return {
				...item,
				sentence: display.label,
				presentation,
				faceText: display.faceText,
			};
		}),
	);
	context.waitUntil?.(
		Promise.all(
			pending
				.slice(0, 3)
				.map((card) => prepareDeckCardFace(context, card, true, deck.model)),
		).catch(() => {}),
	);
	return {
		items: visible,
		heldCount: ranked.filter((item) => !shownIds.has(item.id)).length,
		used: selection.used,
		day: selection.day,
		complete:
			deck.complete &&
			factories.complete &&
			sourcePages.every((page) => page.complete),
		observedAt: now.toISOString(),
	};
}
