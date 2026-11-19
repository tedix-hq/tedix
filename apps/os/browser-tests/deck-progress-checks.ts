import { startFixtureServer } from "./fixture-server";
import { settleAnimations } from "./deck-controls";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import assert from "node:assert/strict";
import { chromium, type Page, type Browser } from "playwright";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
const server = await startFixtureServer();
const { origin } = server;
const uuid = (n: number) =>
	`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = new Date().toISOString();
const cardCount = 10;
const reviewCount = 4;
const manifest = {
	entry: "tedix:app/decision-deck",
	navigation: { work: "deck", workDefault: true },
	config: DecisionDeckConfigSchema.parse({
		version: 1,
		factorySources: [],
		dailyAttentionBudget: cardCount,
	}),
};
const installed = {
	items: [
		{
			gadget: {
				id: uuid(1),
				organizationId: "fictional",
				workspaceId: uuid(2),
				name: "Deck",
				description: null,
				status: "active",
				currentRevisionId: uuid(3),
				sourceBlueprintRevisionId: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt: at,
				updatedAt: at,
			},
			currentRevision: {
				id: uuid(3),
				organizationId: "fictional",
				gadgetId: uuid(1),
				revision: 1,
				manifest,
				sourceArtifactRef: null,
				createdByKind: "user",
				createdById: "dev-operator",
				createdAt: at,
			},
		},
	],
	truncated: false,
};
function request(n: number) {
	return {
		id: uuid(n + 10),
		orgId: uuid(99),
		workItemId: null,
		caseId: null,
		projectId: null,
		kind: "question",
		subject: `${n <= reviewCount ? "Review" : "Planning"} card ${n}`,
		prompt: `Choose card ${n}.`,
		requestedFromType: "user",
		requestedFromId: "dev-operator",
		creatorType: "external_agent",
		creatorId: "fictional-agent",
		creatorSessionId: null,
		state: "open",
		requestedAt: new Date(Date.now() - n * 60_000).toISOString(),
		dueAt: null,
		expiresAt: null,
		resolvedAt: null,
		version: 1,
		metadata: {
			decisionDeck: {
				...DECISION_DECK_EXAMPLES[4],
				proposal: `${n <= reviewCount ? "Review" : "Planning"} card ${n}`,
				classId: "speed",
				protectedEffects: [],
				reversibility: "two_way",
			},
		},
	};
}
async function fixture(
	page: Page,
	options: { failedSave?: Promise<void>; loading?: Promise<void> } = {},
) {
	const decided = new Set<string>();
	const requests = Array.from({ length: cardCount }, (_, i) => request(i + 1));
	await page.route("**/api/rpc/**", async (route) => {
		const url = new URL(route.request().url()),
			path = url.pathname;
		const json = (value: unknown, status = 200) =>
			route.fulfill({
				status,
				contentType: "application/json",
				body: JSON.stringify({ json: value }),
			});
		if (path.endsWith("/osWorkspaces/gadgets/workApps")) return json(installed);
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

		const input =
			route.request().method() === "GET"
				? (JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {})
				: (route.request().postDataJSON()?.json ?? {});
		if (path.endsWith("/attention/getDeckCard")) {
			const row = requests.find((row) => row.id === input.cardId)!;
			return json({
				id: row.id,
				kind: "decision",
				label: `${row.subject}?`,
				project: "Unfiled",
				urgency: "later",
				source: "/work",
				requestedAt: row.requestedAt,
				dueAt: null,
				score: 0,
				decision: row.metadata.decisionDeck,
				interaction: { request: row },
				presentation: {
					version: 2,
					title: `${row.subject}?`,
					context: "A fictional choice is ready for review.",
					body: "Records the selected choice for this example.",
					recommendation: "Review the supplied terms before deciding.",
					actionLabels: { approve: "Approve choice", reject: "Reject choice" },
				},
			});
		}
		if (path.endsWith("/learningFeedback/cardContextPrompt"))
			return json({ ask: false });
		if (path.endsWith("/workInteractions/listInbox")) {
			if (options.loading) await options.loading;
			return json({
				data:
					input.decisionKind || input.states?.includes("resolved")
						? []
						: requests
								.filter((row) => !decided.has(row.id))
								.map((row) => ({
									request: row,
									effectiveState: "open",
									canRespond: true,
									canCancel: false,
									workItem: null,
									responseCount: 0,
									latestDraft: null,
								})),
				nextCursor: null,
				hasMore: false,
				observedAt: at,
			});
		}
		if (path.endsWith("/workInteractions/get"))
			return json({
				request: requests.find((row) => row.id === input.requestId),
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				latestDraft: null,
				responses: { data: [], nextCursor: null, hasMore: false },
			});
		if (path.endsWith("/workInteractions/respond")) {
			if (options.failedSave) {
				await options.failedSave;
				return json(
					{
						defined: false,
						code: "CONFLICT",
						message: "Fictional save failed",
					},
					409,
				);
			}
			decided.add(input.requestId);
			return json({
				request: {
					...requests.find((row) => row.id === input.requestId),
					state: "resolved",
					version: 2,
					resolvedAt: at,
				},
				response: {
					id: uuid(90),
					requestId: input.requestId,
					responseKind: "answer",
					body: input.body,
					artifactRef: null,
					artifactVersion: null,
					artifactDigest: null,
					resolvesRequest: true,
					respondedByType: "user",
					respondedById: "dev-operator",
					respondedBySessionId: null,
					respondedAt: at,
					metadata: {},
				},
			});
		}
		if (path.endsWith("/tediApprovals/list"))
			return json({
				data: [],
				pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
			});
		if (path.endsWith("/workApprovals/listInbox"))
			return json({
				data: [],
				nextCursor: null,
				hasMore: false,
				observedAt: at,
			});
		return route.continue();
	});
}
async function assertNoOverflow(page: Page, state: string) {
	assert(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
		`${state}: no horizontal overflow`,
	);
}
// The dev server compiles lazy Deck modules on first use, and on a busy runner
// that stalls rendering for many seconds. These waits cover that cold start;
// the assertions check what the Deck shows, not how fast it appears.
const PAGE_TIMEOUT_MS = 60_000;
const screenshots = process.env.DECK_PROGRESS_SCREENSHOTS;
const selectedWidth = Number(process.env.DECK_PROGRESS_WIDTH ?? 0);
const selectedTheme = process.env.DECK_PROGRESS_THEME;
let browser: Browser | undefined;
try {
	browser = await chromium.launch();
	for (const [width, height] of [
		[375, 667],
		[390, 844],
		[1280, 800],
	].filter(([width]) => !selectedWidth || selectedWidth === width))
		for (const colorScheme of (["light", "dark"] as const).filter(
			(theme) => !selectedTheme || selectedTheme === theme,
		)) {
			const context = await browser.newContext({
				viewport: { width, height },
				colorScheme,
			});
			const page = await context.newPage();
			page.setDefaultTimeout(PAGE_TIMEOUT_MS);
			// Hold the first inbox read until the skeleton is visible.
			const inbox = Promise.withResolvers<void>();
			const skeleton = page.locator(
				'[data-workspace-app-entry="decision-deck"] [data-slot="skeleton"]',
			);
			try {
				await fixture(page, { loading: inbox.promise });
				await page.goto(`${origin}/work?view=deck`);
				await skeleton.waitFor();
				assert.equal(
					await skeleton.count(),
					1,
					"one placeholder in the card region",
				);
				assert(
					!/Loading decisions…|Loading approval…/.test(
						await page.locator("body").innerText(),
					),
					"no stacked loading labels",
				);
				const bounds = await skeleton.boundingBox();
				assert(
					bounds && bounds.x >= 0 && bounds.width > 0,
					"placeholder's leading edge stays visible",
				);
				await assertNoOverflow(page, `${width} ${colorScheme} loading`);
				if (screenshots)
					await page.screenshot({
						path: `${screenshots}/deck-progress-loading-${width}-${colorScheme}.png`,
					});
			} finally {
				inbox.resolve();
			}
			await skeleton.waitFor({ state: "hidden" });
			await page
				.getByRole("region", { name: "Review card 1?", exact: true })
				.waitFor();
			const progress = page.locator("[data-deck-progress]");
			const tab = page.getByRole("link", { name: /^Decisions/ });
			const checkState = async (state: string) => {
				await settleAnimations(page, "[data-deck-progress]");
				assert(
					await progress.locator("p").evaluate((element) => {
						const range = document.createRange();
						range.selectNodeContents(element);
						return (
							range.getBoundingClientRect().right <=
							element.getBoundingClientRect().right - 8
						);
					}),
					`${width} ${colorScheme} ${state}: progress glyphs stay inside the rounded Deck edge`,
				);
				await assertNoOverflow(page, `${width} ${colorScheme} ${state}`);
				if (screenshots)
					await page.screenshot({
						path: `${screenshots}/deck-progress-${state}-${width}-${colorScheme}.png`,
					});
			};
			assert.equal(
				await progress.locator("p").innerText(),
				`1 of ${cardCount}`,
			);
			/** Work bar total and card progress read one count of undecided cards. */
			const assertCountsAgree = async (state: string) => {
				const bar = page.getByRole("progressbar", {
					name: "Decision progress",
				});
				const total = Number(await bar.getAttribute("aria-valuemax"));
				const done = Number(await bar.getAttribute("aria-valuenow"));
				assert.equal(
					(await tab.innerText()).match(/\d+/)?.[0],
					String(total - done),
					`${width} ${colorScheme} ${state}: Work bar total matches the card`,
				);
			};
			await assertCountsAgree("initial");
			assert.equal(
				await page.locator(".fd-work-bar [data-deck-progress]").count(),
				0,
				"toolbar keeps only its total",
			);
			await checkState("initial");
			for (let n = 1; n <= 2; n++) {
				await page
					.getByRole("region", { name: `Review card ${n}?`, exact: true })
					.getByRole("button", { name: /^Approve/ })
					.click();
			}
			await page
				.getByRole("region", { name: "Review card 3?", exact: true })
				.waitFor();
			assert.equal(
				await progress.locator("p").innerText(),
				`3 of ${cardCount}`,
				"optimistic progress keeps its denominator",
			);
			assert.equal(
				await page
					.getByRole("progressbar", { name: "Decision progress" })
					.getAttribute("aria-valuenow"),
				"2",
			);
			assert.equal(
				await page
					.getByRole("progressbar", { name: "Decision progress" })
					.getAttribute("aria-valuemax"),
				String(cardCount),
			);
			await assertCountsAgree("mid-deck");
			await checkState("mid-deck");
			const search = page.getByRole("textbox", { name: "Find decisions" });
			// Phone filters live in the toolbar's sheet.
			if (!(await search.isVisible()))
				await page
					.getByRole("button", { name: "Filters", exact: true })
					.click();
			await search.fill("Review");
			if (width < 640) await page.keyboard.press("Escape");
			await progress
				.getByText(`3 of ${reviewCount} · filtered`, { exact: true })
				.waitFor();
			assert.equal(
				(await tab.innerText()).match(/\d+/)?.[0],
				String(cardCount - 2),
				"filter does not change the toolbar total",
			);
			await checkState("filtered");
			for (let n = 3; n <= reviewCount; n++)
				await page
					.getByRole("region", { name: `Review card ${n}?`, exact: true })
					.getByRole("button", { name: /^Approve/ })
					.click();
			await page
				.getByRole("heading", {
					name: `All ${reviewCount} done in this filter — nice.`,
					exact: true,
				})
				.waitFor();
			await checkState("filter-finished");
			await page
				.getByRole("button", { name: "Clear filters", exact: true })
				.click();
			await page
				.getByRole("region", {
					name: `Planning card ${reviewCount + 1}?`,
					exact: true,
				})
				.waitFor();
			await checkState("filters-cleared");
			for (let n = reviewCount + 1; n <= cardCount; n++)
				await page
					.getByRole("region", { name: `Planning card ${n}?`, exact: true })
					.getByRole("button", { name: /^Approve/ })
					.click();
			await page
				.getByRole("heading", {
					name: `All ${cardCount} done — nice.`,
					exact: true,
				})
				.waitFor();
			assert.equal(
				await page
					.getByRole("link", { name: "Back to Activity", exact: true })
					.getAttribute("href"),
				"/work?view=feed",
			);
			await checkState("finished");
			await context.close();
			console.log(`Deck progress: ${width} ${colorScheme} passed`);
		}
	if (!selectedWidth || (selectedWidth === 1280 && selectedTheme === "dark")) {
		const page = await browser.newPage();
		page.setDefaultTimeout(PAGE_TIMEOUT_MS);
		const save = Promise.withResolvers<void>();
		await fixture(page, { failedSave: save.promise });
		await page.goto(`${origin}/work?view=deck`);
		const first = page.getByRole("region", {
			name: "Review card 1?",
			exact: true,
		});
		const original = await first.elementHandle();
		await first.getByRole("button", { name: /^Approve/ }).click();
		try {
			assert.equal(
				await page.locator("[data-deck-progress] p").innerText(),
				`1 of ${cardCount}`,
				"pending saves keep the deciding card mounted",
			);
		} finally {
			save.resolve();
		}
		await page
			// The card states the failure inline, with its next step.
			.getByText(/Fictional save failed/)
			.first()
			.waitFor();
		await first.waitFor();
		assert.equal(
			await page.locator("[data-deck-progress] p").innerText(),
			`1 of ${cardCount}`,
			"failed save preserves progress and card",
		);
		assert(
			await original!.evaluate((element) => element.isConnected),
			"failed save preserves the editor instance",
		);
		await page.close();
	}
} finally {
	await browser?.close();
	await server.stop();
}
