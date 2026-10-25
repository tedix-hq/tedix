/**
 * Sample-data pack for the fixture OS: a fictional price-comparison company
 * ("PricePilot") with three focus use cases: Reddit opportunities reviewed by
 * Maya, invoice and stock reconciliation, and critical error reports.
 *
 * Every name, thread, amount and address is invented. The JSON under
 * `demo-pack/` is the only source; nothing reads a tenant or sends anything.
 * Dates are shifted onto "now" each time the pack is built, so the data always
 * reads as today, and a pack older than a week is rebuilt on the next read.
 * The date-shifting idea comes from FounderOS (MIT), lib/demo/store.ts.
 */

import cardsData from "./demo-pack/cards.json";
import chatsData from "./demo-pack/chats.json";
import documentsData from "./demo-pack/documents.json";
import feedData from "./demo-pack/feed.json";
import focusFeed from "../../../packages/api-contract/src/assets/focus-feed.v1.json";
import memberData from "./demo-pack/members.json";
import memoryData from "./demo-pack/memory-facts.json";
import packMeta from "./demo-pack/pack.json";
import presentationData from "./demo-pack/presentations.json";
import skillData from "./demo-pack/skills.json";
import tediData from "./demo-pack/tedis.json";
import workspaceData from "./demo-pack/workspaces.json";
import opportunityCardsApp from "./demo-pack/opportunity-cards-app.json";

type Row = Record<string, unknown>;

const DAY_MS = 86_400_000;
export const DEMO_PACK_MAX_AGE_MS = 7 * DAY_MS;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** Move every ISO instant in `value` by the distance between `anchor` and `nowMs`. */
export function shiftDemoDates<T>(
	value: T,
	anchorIso: string,
	nowMs: number,
): T {
	const delta = nowMs - Date.parse(anchorIso);
	const walk = (node: unknown): unknown => {
		if (typeof node === "string")
			return ISO_INSTANT.test(node)
				? new Date(Date.parse(node) + delta).toISOString()
				: node;
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object")
			return Object.fromEntries(
				Object.entries(node).map(([key, child]) => [key, walk(child)]),
			);
		return node;
	};
	return walk(value) as T;
}

export const demoPackIsStale = (builtAtMs: number, nowMs: number): boolean =>
	nowMs - builtAtMs > DEMO_PACK_MAX_AGE_MS;

export type PackCard = (typeof cardsData)[number];
export const demoPackPresentations = presentationData as Record<
	string,
	unknown
>;
export const demoPackWorkspaces = workspaceData;
export const demoPackFeed = (nowMs: number) =>
	shiftDemoDates(feedData, packMeta.anchor, nowMs);

export const demoFeedPolicy = {
	...focusFeed,
	dailyBudget: 9,
	needsYouLimit: 3,
};
export const demoTodayId = "000000b0-0000-4000-8000-000000000001";
export const demoTodayConfig = (tediId: string, personId: string) => ({
	outputId: demoTodayId,
	skillId: "000000b1-0000-4000-8000-000000000001",
	tediId,
	personId,
	timeZone: "Europe/Berlin",
});
export function demoTodayContent(nowMs: number) {
	return {
		kind: "document" as const,
		blocks: [
			{ type: "paragraph" as const, text: packMeta.description },
			{
				type: "paragraph" as const,
				text: `Sample digest · updated at ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(nowMs)}`,
			},
			{
				type: "paragraph" as const,
				text: "Nothing is sent. All activity is fictional.",
			},
			{
				type: "table" as const,
				headers: [
					"Project",
					"Goal",
					"Progress",
					"Running",
					"Needs you",
					"Project link",
					"Receipts link",
					"Deck link",
				],
				rows: workspaceData.map((space, i) => [
					space.name,
					space.description,
					demoPackFeed(nowMs)[i]!.body,
					"Nothing running now.",
					`${cardsData.filter((c) => groupOf(c) === i && c.status !== "decided").length} reviews`,
					`/work/projects/${uid(118, i + 1)}`,
					`/work?view=feed&projectId=${uid(118, i + 1)}`,
					`/work?view=deck&projectId=${uid(118, i + 1)}`,
				]),
			},
		],
	};
}

/** The pack's cards as dated rows: day 0 is today, older days are history. */
export function demoPackCards(nowMs: number) {
	return cardsData.map((card: PackCard, index) => ({
		card,
		requestedAt: new Date(
			nowMs - card.day * DAY_MS - (20 + (index % 36) * 4) * 60_000,
		).toISOString(),
	}));
}

export const uid = (family: number, n: number): string =>
	`${family.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

export type Group = 0 | 1 | 2;
export const groupOf = (card: PackCard): Group =>
	card.category === "Reddit" ? 0 : card.category === "Reconciliation" ? 1 : 2;

function classOf(card: PackCard, group: Group): string {
	if (group === 0)
		return card.label === "noise" ? "reddit.noise" : "reddit.opportunity";
	return group === 1 ? "finance.reconciliation" : "incident.critical-report";
}

export function demoDecisionEnvelope(
	card: PackCard,
	group: Group,
	lesson: { id: string; text: string },
) {
	const reddit = group === 0;
	return {
		version: 1,
		kind: "decision",
		classId: classOf(card, group),
		proposal: card.title,
		whyNow: card.deadline || "Ready for review",
		recommendation: reddit
			? card.label === "noise"
				? "Skip it: there is no buying intent to answer."
				: "Review the reply draft and mark it useful or not useful."
			: "Review the diagnosis and recommendation, then mark it reviewed.",
		preview: { body: card.story },
		reversibility: card.protected ? "one_way" : "two_way",
		tasteOrStrategy: true,
		protectedEffects: card.protected ? ["production"] : [],
		blastRadius:
			"Sample data only. No message is sent, no money moves and no system changes.",
		confidence: card.label === "noise" ? 0.52 : 0.88,
		costOfWaiting: "The suggestion stays in the review queue.",
		reasoning: `${card.evidence}\n\n${
			reddit
				? "Reddit Scout found buying intent or a verifiable claim. Reply Writer prepared a factual response."
				: "The agent compared the evidence and summarised the discrepancy."
		}\n\nAll text, amounts and sources are fictional.`,
		lessons: [lesson],
		options: [
			{
				id: "approve",
				label: reddit ? "Useful" : "Reviewed",
				intent: "approve",
				consequence: "Save the review in the demo. Nothing is sent or posted.",
				cost: "No external costs.",
			},
			{
				id: "reject",
				label: "Not useful",
				intent: "reject",
				consequence:
					"Dismiss the suggestion and keep the feedback for the next round.",
				cost: "The opportunity is not pursued.",
			},
			{
				id: "later",
				label: "Later",
				intent: "later",
				consequence: "Leave it open for a later review.",
				cost: "The review waits.",
			},
		],
	};
}

/** The fixture module's mutable pieces; typed loosely because the pack replaces them wholesale. */
export interface DemoFixtureContext {
	state: Row;
	handlers: Record<string, (input: never) => unknown>;
	tedis: Row[];
	skills: Row[];
	knowledge: Row[];
	projects: Row[];
	orgMembership: Row & { member: Row };
	rationales: Row[];
	memoryHealth: Row;
}

type Rows = Row[];
const list = (state: Row, key: string): Rows => state[key] as Rows;

/** Replace the fixture company with the sample company and serve its Work. */
export function applyDemoPack(
	ctx: DemoFixtureContext,
	nowMs: number = Date.now(),
): { builtAt: number } {
	const { state, handlers: h } = ctx;
	const stamp = () => new Date().toISOString();
	const at = (days: number, minutes = 0) =>
		new Date(nowMs - days * DAY_MS - minutes * 60_000).toISOString();
	const organization = state.organization as Row;
	const orgId = String(organization.id);
	const builtAt = nowMs;

	organization.name = `${packMeta.organization} · Sample data`;
	organization.slug = packMeta.slug;
	organization.description = packMeta.description;
	organization.metadata = {
		website: `https://${packMeta.slug}.example`,
		contactEmail: memberData[0]!.email,
	};
	Object.assign(ctx.orgMembership, {
		organizationName: organization.name,
		organizationSlug: packMeta.slug,
		tediCount: tediData.length,
		mcpGatewaySlug: packMeta.slug,
		mcpGatewayUrl: "http://localhost:3010",
	});
	const owner = ctx.orgMembership.member;
	Object.assign(owner, {
		name: memberData[0]!.name,
		email: memberData[0]!.email,
		lastActiveAt: stamp(),
	});
	const members = [
		owner,
		{
			...owner,
			id: uid(144, 2),
			descopeUserId: "demo-alex",
			userId: "demo-alex",
			role: "admin",
			name: memberData[1]!.name,
			email: memberData[1]!.email,
		},
	];

	// Tedis: the first fixture row is the template for every sample tedi.
	const tediTemplate = ctx.tedis[0]!;
	ctx.tedis.splice(
		0,
		ctx.tedis.length,
		...tediData.map((tedi, i) => ({
			...tediTemplate,
			id: uid(16, i + 1),
			name: tedi.name,
			displayName: tedi.name,
			slug: tedi.name.toLowerCase().replaceAll(" ", "-"),
			personality: tedi.personality,
			timezone: "Europe/Berlin",
			language: "en",
			lastActivityAt: stamp(),
			lastSeenAt: stamp(),
		})),
	);
	const leadTedi = (group: Group) => ctx.tedis[group === 0 ? 0 : group + 1]!;

	// Workspaces and projects, one per use case.
	const workspaceTemplate = list(state, "workspaces")[0]!;
	state.workspaces = workspaceData.map((space, i) => ({
		...workspaceTemplate,
		id: uid(48, i + 1),
		name: space.name,
		description: space.description,
		createdAt: at(2),
		updatedAt: stamp(),
	}));
	const workspaces = list(state, "workspaces");
	const projectTemplate = ctx.projects[0]!;
	ctx.projects.splice(
		0,
		ctx.projects.length,
		...workspaceData.map((space, i) => ({
			...projectTemplate,
			id: uid(118, i + 1),
			name: space.name,
			leadTediId: leadTedi(i as Group).id,
			workspaceId: workspaces[i]!.id,
		})),
	);
	// Each sample project's Work view is linked into its use-case workspace.
	state.workspaceProjects = workspaces.map((workspace, i) => ({
		id: uid(67, i + 1),
		organizationId: orgId,
		workspaceId: workspace.id,
		projectId: ctx.projects[i]!.id,
		status: "active",
		createdByKind: "user",
		createdById: "dev-operator",
		createdAt: at(2),
		updatedAt: at(2),
		removedAt: null,
	}));

	const skillTemplate = ctx.skills[0]!;
	ctx.skills.splice(
		0,
		ctx.skills.length,
		...skillData.map((title, i) => ({
			...skillTemplate,
			id: uid(32, i + 1),
			tediId: ctx.tedis[i]!.id,
			title,
			slug: title.toLowerCase().replace(/[^a-z]+/g, "-"),
			description: ctx.tedis[i]!.personality,
			summary: ctx.tedis[i]!.personality,
			content: `# ${title}\n\n${String(ctx.tedis[i]!.personality)}\n\n1. Read the sample inputs.\n2. Prepare evidence and a recommendation.\n3. Ask the person to review.\n4. Keep the feedback.`,
			lastUsedAt: stamp(),
			tags: ["sample-data"],
			successCount: [9, 48, 8, 8][i] ?? 1,
		})),
	);

	// Memory facts: what the company has taught its tedis.
	const knowledgeTemplate = ctx.knowledge[0]!;
	ctx.knowledge.splice(
		0,
		ctx.knowledge.length,
		...memoryData.map(([title, content], i) => ({
			...knowledgeTemplate,
			id: uid(115, i + 1),
			title,
			content,
			tediId: ctx.tedis[i < 5 ? 0 : i === 5 ? 2 : 3]!.id,
			entryType: "convention",
			tags: ["sample-data", "learned-rule"],
			createdAt: at(2, i * 12),
			updatedAt: at(0, i * 5),
			confidence: 0.94,
		})),
	);
	const rationaleTemplate = ctx.rationales[0]!;
	ctx.rationales.splice(
		0,
		ctx.rationales.length,
		...ctx.knowledge.slice(0, 6).map((fact, i) => ({
			...rationaleTemplate,
			id: uid(114, i + 1),
			tediId: fact.tediId,
			action: fact.title,
			rationale: fact.content,
			runId: null,
			proofRef: null,
			outcome: "Feedback saved in the sample data.",
			outcomeStatus: "success",
			createdAt: at(1, 120 + i * 5),
			completedAt: at(1, 120 + i * 5),
		})),
	);
	Object.assign(ctx.memoryHealth, {
		totalFacts: memoryData.length,
		activeFacts: memoryData.length,
		archivedFacts: 0,
		totalGaps: 0,
		totalOpinions: 0,
		totalEdges: 0,
		totalDomains: 3,
		avgConfidence: 0.94,
		orphanRatio: 0,
		staleFacts: 0,
		contradictions: 0,
		curiosityQueue: { queued: 0, exploring: 0, completedTotal: 0 },
	});

	// Documents (one per workspace) and chats.
	const outputTemplate = list(state, "outputs")[0]!;
	const revisionTemplate = list(state, "outputRevisions").find(
		(row) => row.outputId === outputTemplate.id,
	)!;
	state.outputs = documentsData.map(([title], i) => ({
		...outputTemplate,
		id: uid(64, i + 1),
		workspaceId: workspaces[i]!.id,
		title,
		currentRevisionId: uid(65, i + 1),
		createdById: leadTedi(i as Group).id,
		createdAt: at(1),
		updatedAt: stamp(),
	}));
	state.outputRevisions = documentsData.map(([title, text], i) => ({
		...revisionTemplate,
		id: uid(65, i + 1),
		outputId: uid(64, i + 1),
		content: {
			kind: "document",
			version: 1,
			blocks: [
				{ type: "heading", level: 1, text: title },
				{ type: "paragraph", text },
				{
					type: "paragraph",
					text: "This is sample data. Every name, amount and source is fictional.",
				},
			],
		},
		createdAt: stamp(),
	}));
	state.workspaceResources = [];
	state.collaborationProposals = [];
	state.executions = [];
	const conversationTemplate = list(state, "conversations")[0]!;
	const messageTemplate = list(state, "messages")[0]!;
	state.conversations = chatsData.map(([title], i) => ({
		...conversationTemplate,
		id: uid(96, i + 1),
		title,
		messageCount: 2,
		lastMessageAt: at(0, 120 + i * 5),
		createdAt: at(2),
		updatedAt: stamp(),
	}));
	state.messages = chatsData.flatMap(([, question, answer], i) =>
		[question, answer].map((content, j) => ({
			...messageTemplate,
			id: uid(97, i * 2 + j + 1),
			conversationId: uid(96, i + 1),
			role: j ? "assistant" : "user",
			content,
			createdAt: at(0, 120 + i * 5 + j),
		})),
	);
	state.homeRuns = [];

	const todayRevisionId = uid(177, 1);
	list(state, "outputs").push({
		...outputTemplate,
		id: demoTodayId,
		workspaceId: workspaces[0]!.id,
		title: "PricePilot Today",
		currentRevisionId: todayRevisionId,
	});
	list(state, "outputRevisions").push({
		...revisionTemplate,
		id: todayRevisionId,
		outputId: demoTodayId,
		content: demoTodayContent(nowMs),
		createdAt: at(0),
	});
	h["organizationPurpose/getActive"] = () => ({ charter: null });

	// Deck cards as work-interaction requests.
	const requests = demoPackCards(nowMs).map(({ card, requestedAt }, index) => {
		const group = groupOf(card);
		const actor = leadTedi(group);
		const lesson = ctx.knowledge[group === 0 ? 1 : group === 1 ? 5 : 6]!;
		const decision = demoDecisionEnvelope(card, group, {
			id: String(lesson.id),
			text: String(lesson.content),
		});
		const resolved = card.status === "decided";
		const request: Row = {
			id: card.id,
			orgId,
			workItemId: null,
			caseId: null,
			projectId: ctx.projects[group]!.id,
			kind: "question",
			subject: card.title,
			prompt: `${card.evidence}\n\n${card.story}`,
			requestedFromType: "user",
			requestedFromId: "dev-operator",
			creatorType: "tedi",
			creatorId: actor.id,
			creatorSessionId: null,
			state: resolved ? "resolved" : "open",
			requestedAt,
			dueAt: null,
			expiresAt: null,
			resolvedAt: resolved
				? new Date(Date.parse(requestedAt) + 40 * 60_000).toISOString()
				: null,
			version: 1,
			metadata: {
				decisionDeck: decision,
				cardContent: card.story,
				sampleData: true,
				sourceLabel: card.evidence,
				cardPresentation:
					(presentationData as Record<string, unknown>)[card.id] ?? null,
			},
		};
		return {
			request,
			effectiveState: request.state as string,
			canRespond: !resolved,
			canCancel: false,
			workItem: null,
			responseCount: resolved ? 1 : 0,
			askedBy: String(actor.displayName),
			rank: cardsData.length - index,
			card,
		};
	});
	type Request = (typeof requests)[number];
	const find = (id: string): Request => {
		const row = requests.find((item) => item.request.id === id);
		if (!row) throw new Error("Sample card not found");
		return row;
	};
	const responses = new Map<string, Row>();
	const response = (row: Request, input: Row = {}): Row => ({
		id: uid(168, requests.indexOf(row) + 1),
		requestId: row.request.id,
		responseKind: "answer",
		body: row.card.decision ?? "Useful",
		resolvesRequest: true,
		artifactRef: null,
		artifactVersion: null,
		artifactDigest: null,
		respondedByType: "user",
		respondedById: "dev-operator",
		respondedBySessionId: null,
		respondedAt: row.request.resolvedAt ?? stamp(),
		metadata: { sampleData: true },
		...input,
	});
	const page = (data: Row[]) => ({
		data,
		pagination: { total: data.length, limit: 100, offset: 0, hasMore: false },
	});
	const empty = () => ({
		data: [],
		nextCursor: null,
		hasMore: false,
		observedAt: stamp(),
	});
	const metadataOf = (row: Request) => row.request.metadata as Row;
	const view = (row: Request): Row => ({
		request: row.request,
		effectiveState: row.effectiveState,
		canRespond: row.canRespond,
		canCancel: false,
		workItem: null,
		responseCount: row.responseCount,
	});

	h["workInteractions/listInbox"] = (input: {
		projectId?: string;
		states?: string[];
		decisionKind?: string;
	}) => ({
		data: requests
			.filter(
				(row) =>
					(!input?.projectId || row.request.projectId === input.projectId) &&
					(!input?.states || input.states.includes(row.effectiveState)) &&
					!input?.decisionKind,
			)
			.map(view),
		nextCursor: null,
		hasMore: false,
		observedAt: stamp(),
	});
	h["workInteractions/get"] = ({ requestId }: { requestId: string }) => {
		const row = find(requestId);
		const saved = responses.get(requestId) ?? response(row);
		return {
			request: row.request,
			effectiveState: row.effectiveState,
			canRespond: row.canRespond,
			canCancel: false,
			latestDraft: null,
			responses: {
				data: row.responseCount ? [saved] : [],
				nextCursor: null,
				hasMore: false,
			},
		};
	};
	h["workInteractions/respond"] = (input: {
		requestId: string;
		expectedRequestVersion?: number;
		responseKind: string;
		body: string;
		resolvesRequest: boolean;
		metadata?: Row;
	}) => {
		const row = find(input.requestId);
		if (
			input.expectedRequestVersion !== undefined &&
			input.expectedRequestVersion !== row.request.version
		)
			throw new Error("Sample card version changed");
		const saved = response(row, {
			id: uid(169, responses.size + 1),
			responseKind: input.responseKind,
			body: input.body,
			resolvesRequest: input.resolvesRequest,
			respondedAt: stamp(),
			metadata: input.metadata ?? {},
		});
		responses.set(row.request.id as string, saved);
		row.request.version = (row.request.version as number) + 1;
		if (input.resolvesRequest) {
			row.request.state = row.effectiveState = "resolved";
			row.request.resolvedAt = stamp();
			row.canRespond = false;
			row.responseCount = 1;
		}
		return { request: row.request, response: saved };
	};

	const deckCard = (row: Request) => ({
		presentation: metadataOf(row).cardPresentation,
		id: row.request.id,
		kind: "decision",
		label: row.request.subject,
		project: row.request.projectId,
		urgency: "later",
		decision: metadataOf(row).decisionDeck,
		source: "sample-data",
		requestedAt: row.request.requestedAt,
		dueAt: null,
		score: row.rank,
		interaction: view(row),
	});
	h["attention/listDeckCards"] = () => {
		const cards = requests.filter((row) => row.canRespond).map(deckCard);
		return { cards, count: cards.length, complete: true, observedAt: stamp() };
	};
	h["attention/getDeckCard"] = ({ cardId }: { cardId: string }) =>
		deckCard(find(cardId));

	// Card text edits keep a revision trail, as the product does.
	const revisions = new Map<string, Row[]>();
	const revisionFor = (
		row: Request,
		body: string,
		revision: number,
		cause: string,
		instruction: string | null,
	): Row => ({
		id: uid(173, requests.indexOf(row) * 100 + revision),
		orgId,
		requestId: row.request.id,
		revision,
		body,
		proposal: null,
		cause,
		actorType: cause === "initial" ? "tedi" : "user",
		actorId: cause === "initial" ? row.request.creatorId : "dev-operator",
		actorSessionId: null,
		instruction,
		responseId: null,
		field: null,
		anchors: null,
		anchorsResolved: null,
		summary: instruction,
		keptHunks: null,
		learningEventId: null,
		parentRevision: revision > 1 ? revision - 1 : null,
		createdAt: stamp(),
	});
	const history = (row: Request): Row[] => {
		const id = row.request.id as string;
		if (!revisions.has(id))
			revisions.set(id, [revisionFor(row, row.card.story, 1, "initial", null)]);
		return revisions.get(id)!;
	};
	const revise = (input: {
		requestId: string;
		body?: string;
		restoreRevision?: number;
		summary?: string;
	}) => {
		const row = find(input.requestId);
		const trail = history(row);
		const body =
			input.body ??
			(trail.find((item) => item.revision === input.restoreRevision)?.body as
				| string
				| undefined);
		if (!body) throw new Error("Sample revision body required");
		const revision = revisionFor(
			row,
			body,
			trail.length + 1,
			input.restoreRevision ? "restore" : "human_edit",
			input.summary ?? null,
		);
		trail.push(revision);
		row.request.version = (row.request.version as number) + 1;
		metadataOf(row).cardContent = body;
		(metadataOf(row).decisionDeck as { preview: { body: string } }).preview = {
			body,
		};
		return revision;
	};
	h["workInteractions/cardHistory"] = ({
		requestId,
	}: {
		requestId: string;
	}) => ({
		revisions: [...history(find(requestId))].reverse(),
		styleRules: [],
		nextBeforeRevision: null,
		pending: null,
	});
	h["workInteractions/reviseCard"] = revise;
	h["workInteractions/requestCardChanges"] = (input: {
		requestId: string;
		instruction: string;
	}) => {
		const row = find(input.requestId);
		const current = String(metadataOf(row).cardContent);
		const body = /short|brief|concise/i.test(input.instruction)
			? (current.split(/(?<=[.!?])\s+/)[0] ?? current)
			: current;
		revise({
			requestId: input.requestId,
			body: `${body}\n\nEditor note (sample data): ${input.instruction}`,
			summary: input.instruction,
		});
		return row.request;
	};

	// Learning: the facts above are the lessons; events stay in memory.
	const events: Row[] = [];
	h["learningFeedback/model"] = () => ({
		asOf: stamp(),
		weights: {
			personal: [],
			organization: [],
			time: [],
			urgency: [],
			priority: [],
			usefulness: [],
		},
		readiness: [],
		preferences: [],
		lessons: ctx.knowledge.map((fact) => ({
			id: fact.id,
			text: fact.content,
			classId: null,
		})),
		eventCount: events.length,
		receipts: [],
		config: {
			enabled: false,
			unchangedThreshold: 5,
			focusFeed: demoFeedPolicy,
			timezone: "Europe/Berlin",
		},
	});
	h["learningFeedback/listInteractions"] = () => ({
		events,
		nextCursor: null,
		hasMore: false,
	});
	h["learningFeedback/recordInteraction"] = (input: Row) => {
		const event = {
			...input,
			id: uid(170, events.length + 1),
			organizationId: orgId,
			actorType: "user",
			actorId: "dev-operator",
			tediId: input.tediId ?? null,
			clientEventId: input.clientEventId ?? uid(170, events.length + 1),
			signalClass: input.signalClass ?? "quality",
			scopeKind: "personal",
			scopeId: "dev-operator",
			metadata: input.metadata ?? {},
			occurredAt: input.occurredAt ?? stamp(),
			createdAt: stamp(),
		};
		events.push(event);
		return { event, duplicate: false };
	};
	h["agentTurnTriage/listLessons"] = () => ({
		lessons: ctx.knowledge.map((fact) => ({
			id: fact.id,
			text: fact.content,
			addedAt: fact.updatedAt,
			fromCallerFeedback: true,
			evidence: {
				version: 1,
				supportCount: 4,
				state: "live",
				sources: [{ kind: "correction", id: fact.id, quote: fact.title }],
			},
			learnedFrom: {
				replies: 4,
				lastReplyAt: fact.updatedAt,
				fromCaller: true,
			},
		})),
	});

	// Feed, with its dates shifted onto today.
	const feed = shiftDemoDates(feedData, packMeta.anchor, nowMs);
	h["workItems/listActivity"] = () => ({
		events: feed.map((event, i) => ({
			id: uid(171, i + 1),
			workItemId: uid(172, i + 1),
			workItemTitle: event.title,
			workItemDisposition: "completed",
			eventType: "work.completed",
			authorType: "tedi",
			authorId: ctx.tedis.find((tedi) => tedi.name === event.agent)?.id,
			agentHarness: null,
			agentSession: null,
			settlement: null,
			body: event.body,
			metadata: { sampleData: true },
			createdAt: event.createdAt,
		})),
		nextCursor: null,
		truncated: false,
	});
	h["workItems/listAttemptProjection"] = empty;
	h["workApprovals/listInbox"] = empty;
	h["tediApprovals/list"] = () => page([]);
	h["members/listMembers"] = () => page(members);
	h["userProfile/getMine"] = () => ({
		id: "dev-operator",
		name: owner.name,
		displayName: owner.name,
		email: owner.email,
		avatarUrl: null,
	});

	// Feed and Deck, installed where the Work apps live.
	const gadgetTemplate = list(state, "gadgets")[0]!;
	const gadgetRevisionTemplate = list(state, "gadgetRevisions")[0]!;
	state.gadgets = [];
	state.gadgetRevisions = [];
	for (const [i, role] of (["feed", "deck"] as const).entries()) {
		const id = uid(49, 10 + i);
		const revisionId = uid(50, 10 + i);
		list(state, "gadgets").push({
			...gadgetTemplate,
			id,
			name: role === "feed" ? "Feed" : "Deck",
			workspaceId: workspaces[0]!.id,
			currentRevisionId: revisionId,
		});
		list(state, "gadgetRevisions").push({
			...gadgetRevisionTemplate,
			id: revisionId,
			gadgetId: id,
			manifest: {
				entry: `tedix:app/${role === "feed" ? "activity-feed" : "decision-deck"}`,
				capabilities: [],
				navigation: { work: role, workDefault: role === "feed" },
				config:
					role === "feed"
						? {
								version: 1,
								scope: "organization",
								projects: [],
								pageSize: 50,
								attentionBudget: 30,
								today: demoTodayConfig(String(leadTedi(0).id), "dev-operator"),
							}
						: { version: 1, limit: 100, examples: [], factorySources: [] },
			},
		});
	}
	list(state, "gadgets").push({
		...gadgetTemplate,
		id: uid(49, 12),
		name: "Office",
		workspaceId: workspaces[0]!.id,
		currentRevisionId: uid(50, 12),
	});
	list(state, "gadgetRevisions").push({
		...gadgetRevisionTemplate,
		id: uid(50, 12),
		gadgetId: uid(49, 12),
		manifest: {
			entry: "tedix:app/office",
			capabilities: [],
			navigation: { board: true },
			config: { version: 1 },
		},
	});
	// The first app with its own code: Opportunity cards reads the Reddit
	// workspace's Opportunities sheet through a granted slot. The sheet, the
	// slot and the reviewer are data; the code is the same for every tenant.
	const opportunitiesOutputId = uid(64, 20);
	const opportunitiesRevisionId = uid(65, 20);
	list(state, "outputs").push({
		...outputTemplate,
		id: opportunitiesOutputId,
		workspaceId: workspaces[0]!.id,
		kind: "sheet",
		title: "Opportunities",
		currentRevisionId: opportunitiesRevisionId,
		createdAt: at(1),
		updatedAt: stamp(),
	});
	list(state, "outputRevisions").push({
		...revisionTemplate,
		id: opportunitiesRevisionId,
		outputId: opportunitiesOutputId,
		content: {
			kind: "sheet",
			columns: ["#", "Source (link)", "Who", "Why (rule)", "Draft", "Useful?"],
			rows: cardsData
				.filter((card) => card.category === "Reddit")
				.slice(0, 8)
				.map((card, index) => [
					index + 1,
					`https://reddit.example/r/BuyItForLife/fable-${String(index + 1).padStart(2, "0")}`,
					card.agent,
					card.title,
					card.story,
					card.status === "decided" ? "yes" : "",
				]),
		},
		createdAt: at(0),
	});
	list(state, "workspaceResources").push({
		id: uid(70, 1),
		organizationId: orgId,
		workspaceId: workspaces[0]!.id,
		slot: "opportunities",
		providerId: "tedix",
		connectionScope: "tenant",
		personalOwnerUserId: null,
		connectionInstanceId: null,
		providerAccess: { canRead: true, canWrite: false },
		requiredScopes: [],
		resourceType: "output",
		providerResourceId: opportunitiesOutputId,
		name: "Opportunities sheet",
		metadata: {},
		status: "active",
		createdByKind: "user",
		createdById: "dev-operator",
		createdAt: at(1),
		updatedAt: at(1),
		removedAt: null,
	});
	list(state, "gadgets").push({
		...gadgetTemplate,
		id: uid(49, 14),
		name: "Opportunity cards",
		description: "Review today's Reddit opportunities one card at a time.",
		workspaceId: workspaces[0]!.id,
		currentRevisionId: uid(50, 14),
	});
	list(state, "gadgetRevisions").push({
		...gadgetRevisionTemplate,
		id: uid(50, 14),
		gadgetId: uid(49, 14),
		manifest: {
			entry: "tedix:runtime/v1",
			capabilities: [],
			resourceGrants: [{ slot: "opportunities", operations: ["outputs.read"] }],
			description: "Review today's Reddit opportunities one card at a time.",
			config: {
				version: 1,
				settings: {
					slot: "opportunities",
					reviewer: "Maya",
					columns: {
						number: "#",
						source: "Source",
						who: "Who",
						why: "Why",
						draft: "Draft",
						useful: "Useful?",
					},
				},
			},
		},
	});
	(state.gadgetCode as Record<string, unknown>) = {
		...((state.gadgetCode as Record<string, unknown>) ?? {}),
		[uid(50, 14)]: opportunityCardsApp,
	};
	// The read-only System map, reachable from the workspace like any app.
	list(state, "gadgets").push({
		...gadgetTemplate,
		id: uid(49, 13),
		name: "System map",
		workspaceId: workspaces[0]!.id,
		currentRevisionId: uid(50, 13),
	});
	list(state, "gadgetRevisions").push({
		...gadgetRevisionTemplate,
		id: uid(50, 13),
		gadgetId: uid(49, 13),
		manifest: {
			entry: "tedix:app/system-map",
			capabilities: [],
			config: { version: 1 },
		},
	});
	return { builtAt };
}
