import assert from "node:assert/strict";
import { chromium } from "playwright";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { startFixtureServer } from "./fixture-server";

// Installs a Deck gadget in the fixture store, which has no reset.
const server = await startFixtureServer("/", {
	shared: false,
	stdout: "ignore",
});
const { origin } = server;
async function rpc(path: string, input: unknown) {
	const response = await fetch(`${origin}/api/rpc/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ json: input }),
	});
	assert(response.ok, `${path}: ${await response.clone().text()}`);
	return (await response.json()).json;
}
const { items: spaces } = await rpc("osWorkspaces/workspaces/list", {
	status: "active",
	limit: 100,
});
const workspaceId = spaces[0].id;
const stamp = Date.now();
const installed = [];
for (const role of ["feed", "deck"] as const) {
	const { gadget } = await rpc("osWorkspaces/gadgets/create", {
		workspaceId,
		name: `Priority bands ${role} ${stamp}`,
	});
	const { gadget: current, revision } = await rpc(
		"osWorkspaces/gadgets/revise",
		{
			workspaceId,
			gadgetId: gadget.id,
			manifest: {
				entry:
					role === "feed"
						? "tedix:app/activity-feed"
						: "tedix:app/decision-deck",
				navigation: { work: role, workDefault: role === "feed" },
				capabilities: [],
				config:
					role === "feed"
						? { version: 1, scope: "organization", projects: [] }
						: {
								version: 1,
								dailyAttentionBudget: 50,
								batchTimesUtc: ["00:00"],
							},
			},
		},
	);
	installed.push({ gadget: current, currentRevision: revision });
}

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const work = (patch: Record<string, unknown>) => ({
	dueDate: null,
	deadline: null,
	riskLevel: "medium",
	blocksCount: 0,
	blocksRunning: false,
	...patch,
});
const asks = [
	{ n: 1, subject: "Choose the fictional newsletter colour?" },
	{
		n: 2,
		subject: "Pick the fictional release owner?",
		sourceWork: work({ blocksCount: 5 }),
	},
	{
		n: 3,
		subject: "Confirm the fictional Demo Day booth?",
		sourceWork: work({ deadline: iso(day) }),
	},
	{
		n: 4,
		subject: "Answer the fictional overdue supplier note?",
		dueAt: iso(-3 * day),
	},
].map(({ n, subject, sourceWork, dueAt }) =>
	WorkInteractionInboxRowSchema.parse({
		request: {
			id: `5555555${n}-5555-4555-8555-555555555555`,
			orgId: "44444444-4444-4444-8444-444444444444",
			workItemId: null,
			caseId: null,
			projectId: null,
			creatorSessionId: null,
			state: "open",
			requestedAt: iso(-3_600_000),
			dueAt: dueAt ?? null,
			expiresAt: null,
			resolvedAt: null,
			metadata: { decisionClass: "fictional.choice" },
			subject,
			prompt: subject,
			kind: "question",
			version: 1,
			creatorType: "user",
			creatorId: "fictional-asker",
			requestedFromType: "user",
			requestedFromId: "dev-operator",
		},
		effectiveState: "open",
		canRespond: true,
		canCancel: false,
		workItem: null,
		responseCount: 0,
		...(sourceWork ? { sourceWork } : {}),
	}),
);

const browser = await chromium.launch({ headless: true });
try {
	for (const width of [800, 1280]) {
		const routed = new Set<string>();
		let handoff: { requestId?: string; reason?: string } | undefined;
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.route("**/api/rpc/**", async (route) => {
			const url = new URL(route.request().url());
			const path = url.pathname;
			const json = (value: unknown) =>
				route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ json: value }),
				});
			const input =
				route.request().method() === "GET"
					? (JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {})
					: (route.request().postDataJSON()?.json ?? {});
			const open = asks.filter((row) => !routed.has(row.request.id));
			if (path.endsWith("/osWorkspaces/gadgets/workApps"))
				return json({ items: installed, truncated: false });
			if (path.endsWith("/workInteractions/delegateToSteward")) {
				handoff = input;
				routed.add(input.requestId);
				const row = asks.find((ask) => ask.request.id === input.requestId)!;
				return json({
					request: { ...row.request, version: 2 },
					steward: { id: "66666666-6666-4666-8666-666666666666", name: "CTO" },
					woken: true,
				});
			}
			if (path.endsWith("/attention/getDeckCard")) {
				const row = asks.find((ask) => ask.request.id === input.cardId);
				if (!row) return route.fulfill({ status: 404, body: "{}" });
				return json(
					DeckCardSchema.parse({
						id: row.request.id,
						kind: "question",
						label: row.request.subject,
						project: "Unfiled",
						urgency: "later",
						source: "/work",
						score: 0,
						requestedAt: row.request.requestedAt,
						dueAt: row.request.dueAt,
						decision: null,
						interaction: row,
						presentation: {
							version: 2,
							title: row.request.subject,
							context: "A fictional ask for the priority bands.",
							body: "Records your answer; sends nothing.",
							recommendation: "Review first because only you know.",
						},
					}),
				);
			}
			if (path.endsWith("/workInteractions/listInbox"))
				return json({
					data:
						input.decisionKind || input.states?.includes("resolved")
							? []
							: open,
					hasMore: false,
					nextCursor: null,
					observedAt: new Date().toISOString(),
				});
			if (path.endsWith("/workInteractions/get")) {
				const row = asks.find((ask) => ask.request.id === input.requestId);
				return json({
					...(row ?? asks[0]),
					responses: { data: [], hasMore: false, nextCursor: null },
				});
			}
			if (path.endsWith("/tediApprovals/list"))
				return json({
					data: [],
					pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
				});
			if (path.endsWith("/userProfile/getMine"))
				return json({ id: "dev-operator" });
			if (path.endsWith("/learningFeedback/model"))
				return json(
					learnDecisions({
						organizationId: "fictional",
						personId: "dev-operator",
						events: [],
						now: new Date(),
					}),
				);
			if (path.endsWith("/learningFeedback/listInteractions"))
				return json({ events: [] });
			if (path.endsWith("/learningFeedback/recordInteraction"))
				return json({ event: { id: crypto.randomUUID() } });
			if (path.endsWith("/learningFeedback/recordExposure"))
				return json({ id: crypto.randomUUID() });
			if (
				[
					"/workApprovals/listInbox",
					"/workItems/listActivity",
					"/workItems/listAttemptProjection",
				].some((suffix) => path.endsWith(suffix))
			)
				return json({
					data: [],
					events: [],
					hasMore: false,
					nextCursor: null,
					observedAt: new Date().toISOString(),
				});
			if (path.endsWith("/externalAgentIdentity/listPrincipals"))
				return json([]);
			return route.continue();
		});
		await page.goto(`${origin}/work?view=deck`);
		const bands = page.getByRole("group", { name: "Priority band" });
		await bands.waitFor();
		const band = (label: string) =>
			bands.getByRole("button", { name: label, exact: true });
		for (const label of ["All 4", "Today 2", "This week 1", "Whenever 1"])
			await band(label).waitFor();
		// The overdue ask leads with its reason.
		await page
			.getByRole("region", {
				name: "Answer the fictional overdue supplier note?",
				exact: true,
			})
			.waitFor();
		await page.locator(".fd-deck-ask", { hasText: "Overdue since" }).waitFor();
		// The strip shows the overdue deadline on the left in the warning colour.
		const timeline = page.getByRole("group", {
			name: "Deadlines in the next 14 days",
		});
		const dots = timeline.locator(".fd-deck-timeline-dot");
		assert.equal(await dots.count(), 2, `two dated asks at ${width}px`);
		const overdue = timeline.locator(
			'.fd-deck-timeline-dot[data-overdue="true"]',
		);
		assert.equal(await overdue.count(), 1);
		const [overdueBox, futureBox] = await Promise.all([
			overdue.boundingBox(),
			timeline
				.locator('.fd-deck-timeline-dot[data-overdue="false"]')
				.boundingBox(),
		]);
		assert(overdueBox && futureBox && overdueBox.x < futureBox.x);
		const shots = process.env.DECK_BANDS_SCREENSHOT_DIR;
		if (shots)
			await page.screenshot({ path: `${shots}/deck-bands-${width}.png` });
		// This week: the blocking ask, with its reason and the CTO tedi action.
		await band("This week 1").click();
		await page
			.getByRole("region", {
				name: "Pick the fictional release owner?",
				exact: true,
			})
			.waitFor();
		await page.locator(".fd-deck-ask", { hasText: "Blocks 5 tasks" }).waitFor();
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`bands and timeline fit at ${width}px`,
		);
		await page
			.getByRole("button", { name: "Let the CTO tedi decide", exact: true })
			.click();
		await band("This week 0").waitFor();
		assert.equal(handoff?.requestId, asks[1]!.request.id);
		assert.equal(handoff?.reason, "Blocks 5 tasks");
		await band("All 3").waitFor();
		assert.equal(
			await page
				.getByRole("region", { name: "Pick the fictional release owner?" })
				.count(),
			0,
			"the routed ask leaves For you",
		);
		await page.close();
	}
	console.log(
		"Deck priority bands, timeline and CTO tedi routing at 800px and 1280px passed.",
	);
} finally {
	await browser.close();
	await server.stop();
}
