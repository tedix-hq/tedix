import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Page, type Browser } from "playwright";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
const cwd = new URL("../", import.meta.url).pathname;
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve) => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn(
	[
		"../../node_modules/.bin/vp",
		"dev",
		"--port",
		port,
		"--strictPort",
		"--host",
		"127.0.0.1",
	],
	{ cwd, stdout: "inherit", stderr: "inherit", detached: true },
);
const uuid = (n: number) =>
	`10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = new Date().toISOString();
const manifest = {
	entry: "tedix:app/decision-deck",
	navigation: { work: "deck", workDefault: true },
	config: DecisionDeckConfigSchema.parse({
		version: 1,
		factorySources: [],
		dailyAttentionBudget: 20,
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
		subject: `${n <= 7 ? "Review" : "Planning"} card ${n}`,
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
				proposal: `${n <= 7 ? "Review" : "Planning"} card ${n}`,
				classId: "speed",
				protectedEffects: [],
				reversibility: "two_way",
			},
		},
	};
}
async function fixture(
	page: Page,
	options: { failure?: boolean; loading?: boolean } = {},
) {
	const decided = new Set<string>();
	const requests = Array.from({ length: 20 }, (_, i) => request(i + 1));
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
			if (options.loading)
				await new Promise((resolve) => setTimeout(resolve, 4000));
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
			await new Promise((resolve) => setTimeout(resolve, 500));
			if (options.failure)
				return json(
					{
						defined: false,
						code: "CONFLICT",
						message: "Fictional save failed",
					},
					409,
				);
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
const screenshots = process.env.DECK_PROGRESS_SCREENSHOTS;
let browser: Browser | undefined;
try {
	await waitForFixtureServer(origin, { server });
	browser = await chromium.launch();
	for (const width of [1280, 390])
		for (const colorScheme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				viewport: { width, height: width === 390 ? 844 : 800 },
				colorScheme,
			});
			const page = await context.newPage();
			page.setDefaultTimeout(15000);
			await fixture(page);
			await page.goto(`${origin}/work?view=deck`);
			await page
				.getByRole("region", { name: "Review card 1?", exact: true })
				.waitFor();
			const progress = page.locator("[data-deck-progress]");
			const tab = page.getByRole("link", { name: /^Deck/ });
			const screenshot = async (state: string) => {
				await page.waitForTimeout(
					screenshots && state === "finished" ? 5000 : 250,
				);
				assert(
					await progress.locator("p").evaluate((element) => {
						const range = document.createRange();
						range.selectNodeContents(element);
						return (
							range.getBoundingClientRect().right <=
							element.getBoundingClientRect().right - 8
						);
					}),
					"progress glyphs stay inside the rounded Deck edge",
				);
				assert(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= innerWidth,
					),
					"no horizontal overflow",
				);
				if (screenshots)
					await page.screenshot({
						path: `${screenshots}/deck-progress-${state}-${width}-${colorScheme}.png`,
					});
			};
			assert.equal(await progress.locator("p").innerText(), "1 of 20");
			assert.equal(
				await page.locator(".fd-work-bar [data-deck-progress]").count(),
				0,
				"toolbar keeps only its total",
			);
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
				"3 of 20",
				"optimistic progress keeps its denominator",
			);
			assert.equal(
				await page
					.getByRole("progressbar", { name: "Deck progress" })
					.getAttribute("aria-valuenow"),
				"2",
			);
			assert.equal(
				await page
					.getByRole("progressbar", { name: "Deck progress" })
					.getAttribute("aria-valuemax"),
				"20",
			);
			await screenshot("mid-deck");
			const search = page.getByRole("textbox", { name: "Find decisions" });
			// Phone filters live in the toolbar's sheet.
			if (!(await search.isVisible()))
				await page
					.getByRole("button", { name: "Filters", exact: true })
					.click();
			await search.fill("Review");
			if (width === 390) await page.keyboard.press("Escape");
			await page.waitForTimeout(650);
			assert.equal(
				await progress.locator("p").innerText(),
				"3 of 7 · filtered",
			);
			assert.match(
				await tab.innerText(),
				/18/,
				"filter does not change the toolbar total",
			);
			await screenshot("filtered");
			for (let n = 3; n <= 7; n++)
				await page
					.getByRole("region", { name: `Review card ${n}?`, exact: true })
					.getByRole("button", { name: /^Approve/ })
					.click();
			await page
				.getByRole("heading", {
					name: "All 7 done in this filter — nice.",
					exact: true,
				})
				.waitFor();
			await page
				.getByRole("button", { name: "Clear filters", exact: true })
				.click();
			for (let n = 8; n <= 20; n++)
				await page
					.getByRole("region", { name: `Planning card ${n}?`, exact: true })
					.getByRole("button", { name: /^Approve/ })
					.click();
			await page
				.getByRole("heading", { name: "All 20 done — nice.", exact: true })
				.waitFor();
			assert.equal(
				await page
					.getByRole("link", { name: "Back to Feed", exact: true })
					.getAttribute("href"),
				"/work?view=feed",
			);
			await screenshot("finished");
			await context.close();
			const loading = await browser.newContext({
				viewport: { width, height: width === 390 ? 844 : 800 },
				colorScheme,
			});
			const loadingPage = await loading.newPage();
			await fixture(loadingPage, { loading: true });
			await loadingPage.goto(`${origin}/work?view=deck`);
			const skeleton = loadingPage.locator(
				'[data-workspace-app-entry="decision-deck"] [data-slot="skeleton"]',
			);
			await skeleton.waitFor();
			assert.equal(
				await skeleton.count(),
				1,
				"one placeholder in the card region",
			);
			assert(
				!/Loading decisions…|Loading approval…/.test(
					await loadingPage.locator("body").innerText(),
				),
				"no stacked loading labels",
			);
			const bounds = await skeleton.boundingBox();
			assert(
				bounds && bounds.x >= 0 && bounds.width > 0,
				"placeholder's leading edge stays visible",
			);
			if (screenshots)
				await loadingPage.screenshot({
					path: `${screenshots}/deck-progress-loading-${width}-${colorScheme}.png`,
				});
			await loading.close();
			console.log(`Deck progress: ${width} ${colorScheme} passed`);
		}
	const page = await browser.newPage();
	await fixture(page, { failure: true });
	await page.goto(`${origin}/work?view=deck`);
	const first = page.getByRole("region", {
		name: "Review card 1?",
		exact: true,
	});
	const original = await first.elementHandle();
	await first.getByRole("button", { name: /^Approve/ }).click();
	assert.equal(
		await page.locator("[data-deck-progress] p").innerText(),
		"1 of 20",
		"pending saves keep the deciding card mounted",
	);
	await page
		.getByText("Fictional save failed", { exact: true })
		.first()
		.waitFor();
	await first.waitFor();
	assert.equal(
		await page.locator("[data-deck-progress] p").innerText(),
		"1 of 20",
		"failed save preserves progress and card",
	);
	assert(
		await original!.evaluate((element) => element.isConnected),
		"failed save preserves the editor instance",
	);
	await page.close();
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
