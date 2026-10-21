import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";

/*
 * The Source chip on /work narrows Deck and Feed to Work asks, one factory or
 * the workspace holding it, at phone and desktop widths. Two fictional
 * factories (Inbox, Social) and one fictional Work question share the view.
 */
const cwd = new URL("../", import.meta.url).pathname;
const probe = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () => new Response(),
});
const port = process.env.TEDIX_BROWSER_TEST_PORT || String(probe.port!);
probe.stop();
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
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
);
const shots = process.env.TEDIX_SCREENSHOT_DIR;

async function rpc(path: string, input: unknown) {
	const response = await fetch(`${origin}/api/rpc/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ json: input }),
	});
	assert(response.ok, `${path}: ${await response.clone().text()}`);
	return (await response.json()).json;
}

const browser = await chromium.launch({ headless: true });
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	const { items: spaces } = await rpc("osWorkspaces/workspaces/list", {
		status: "active",
		limit: 100,
	});
	const workspaceId = spaces[0].id;
	const workspaceName: string = spaces[0].name;
	const { data: projects } = await rpc("projects/list", { limit: 100 });
	const projectId = projects[0].id;
	const stamp = Date.now();
	const sources = ["Inbox", "Social"].map((label) => ({
		label,
		workspaceId,
		cardSheetPrefix: `Source filter ${stamp} ${label} cards `,
		maxRuns: 3,
		columns: {
			source: "Source",
			type: "Type",
			who: "Who",
			why: "Why",
			draft: "Draft",
			useful: "Useful?",
			reason: "Reason",
			done: "Done?",
		},
		doIt: "approve",
	}));
	const sheets = await Promise.all(
		sources.map((source) =>
			rpc("osWorkspaces/outputs/create", {
				workspaceId,
				kind: "sheet",
				title: `${source.cardSheetPrefix}today`,
				content: {
					kind: "sheet",
					columns: [
						"Type",
						"Source",
						"Who",
						"Why",
						"Draft",
						"Useful?",
						"Reason",
						"Done?",
					],
					rows: [
						[
							"opportunity",
							`https://example.com/${source.label.toLowerCase()}`,
							"Morgan Example",
							`Review the fictional ${source.label.toLowerCase()} opportunity.`,
							"A fictional draft for review.",
							"",
							"",
							"",
						],
					],
				},
			}),
		),
	);
	const installed = [];
	for (const role of ["feed", "deck"] as const) {
		const { gadget } = await rpc("osWorkspaces/gadgets/create", {
			workspaceId,
			name: `Source filter ${role} ${stamp}`,
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
							? {
									version: 1,
									scope: "organization",
									projects: [{ id: projectId, label: "Opportunities" }],
									factorySources: sources.map((source) => ({
										projectId,
										source,
									})),
								}
							: {
									version: 1,
									dailyAttentionBudget: 10,
									batchTimesUtc: ["00:00"],
									factorySources: sources,
								},
				},
			},
		);
		installed.push({ gadget: current, currentRevision: revision });
	}
	const native = WorkInteractionInboxRowSchema.parse({
		request: {
			id: "55555555-5555-4555-8555-555555555555",
			orgId: "44444444-4444-4444-8444-444444444444",
			workItemId: null,
			caseId: null,
			projectId: null,
			creatorSessionId: null,
			state: "open",
			requestedAt: "2026-10-17T10:00:00Z",
			dueAt: null,
			expiresAt: null,
			resolvedAt: null,
			metadata: { decisionClass: "opportunity.delivery" },
			subject: "Pick the fictional delivery date.",
			prompt: "Choose a fictional delivery date.",
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
	});
	const title = (index: number) =>
		index >= 0
			? `Review the fictional ${sources[index]!.label.toLowerCase()} opportunity?`
			: "Pick the fictional delivery date?";

	async function fixture(page: Page) {
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
			if (path.endsWith("/osWorkspaces/gadgets/workApps"))
				return json({ items: installed, truncated: false });
			if (path.endsWith("/attention/getDeckCard")) {
				const index = sheets.findIndex(
					({ output }) => input.cardId === `factory:${output.id}:0`,
				);
				const factory = index >= 0;
				return json(
					DeckCardSchema.parse({
						id: input.cardId,
						kind: factory ? "decision" : "question",
						label: factory ? sources[index]!.label : native.request.subject,
						project: "Opportunities",
						urgency: "later",
						source: "/work",
						score: 0,
						requestedAt: native.request.requestedAt,
						dueAt: null,
						decision: null,
						...(factory
							? {
									factory: {
										outputId: sheets[index]!.output.id,
										sourceIndex: index,
										rowIndex: 0,
										revision: 1,
										draft: "A fictional draft for review.",
										why: "A fictional opportunity is ready.",
										sourceText: "Morgan Example",
									},
								}
							: { interaction: native }),
						presentation: {
							version: 2,
							title: title(index),
							context: "A fictional card for the source filter.",
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
							: [native],
					hasMore: false,
					nextCursor: null,
					observedAt: new Date().toISOString(),
				});
			if (path.endsWith("/workInteractions/get"))
				return json({
					...native,
					responses: { data: [], hasMore: false, nextCursor: null },
				});
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
	}

	async function choose(page: Page, label: string) {
		const chip = page.getByRole("combobox", { name: "Card source" });
		// Phones keep the Deck's filters behind one Filters button.
		const filtersOpen = !(await chip.isVisible());
		if (filtersOpen)
			await page.getByRole("button", { name: "Filters" }).click();
		await chip.click();
		await page.getByRole("option", { name: label, exact: true }).click();
		await page.getByRole("listbox").waitFor({ state: "hidden" });
		if (filtersOpen) await page.keyboard.press("Escape");
	}
	async function fits(page: Page, what: string) {
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			`${what} fits without horizontal scroll`,
		);
	}
	const deckCard = (page: Page, index: number) =>
		page.getByRole("region", { name: title(index) });

	for (const width of [390, 1280]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await fixture(page);

		await page.goto(`${origin}/work?view=deck`);
		await page
			.getByRole("region", { name: /Review the fictional|Pick the fictional/ })
			.first()
			.waitFor();
		await choose(page, "Social");
		await deckCard(page, 1).waitFor();
		await fits(page, `Deck at ${width}px`);
		if (shots) {
			await mkdir(shots, { recursive: true });
			await page.screenshot({
				path: `${shots}/deck-source-social-${width}.png`,
				fullPage: true,
			});
		}
		await choose(page, "Work");
		await deckCard(page, -1).waitFor();
		await choose(page, `In ${workspaceName}`);
		await page
			.getByRole("region", { name: /Review the fictional (inbox|social)/ })
			.waitFor();

		await page.goto(`${origin}/work?view=feed`);
		const inbox = page.getByRole("link", {
			name: /Review the fictional inbox opportunity/,
		});
		const social = page.getByRole("link", {
			name: /Review the fictional social opportunity/,
		});
		await social.waitFor();
		await inbox.waitFor();
		await choose(page, "Inbox");
		await social.waitFor({ state: "detached" });
		assert(await inbox.isVisible(), "Inbox stays when filtering to Inbox");
		await fits(page, `Feed at ${width}px`);
		if (shots)
			await page.screenshot({
				path: `${shots}/feed-source-inbox-${width}.png`,
				fullPage: true,
			});
		await choose(page, "Work");
		await inbox.waitFor({ state: "detached" });
		await page.close();
	}
	console.log("Deck and Feed source filter at 390px and 1280px passed.");
} finally {
	await browser.close();
	process.kill(-server.pid, "SIGTERM");
}
