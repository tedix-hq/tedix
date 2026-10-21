import { waitForFixtureServer } from "../dev/fixture-server-readiness";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, type Page } from "playwright";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";

const cwd = new URL("../", import.meta.url).pathname;
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve) => probe.close(() => resolve()));
const origin = process.env.SOCIAL_CARDS_ORIGIN ?? `http://127.0.0.1:${port}`;
const server = process.env.SOCIAL_CARDS_ORIGIN
	? null
	: Bun.spawn(
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
	await waitForFixtureServer(origin, { server });
	const { items: spaces } = await rpc("osWorkspaces/workspaces/list", {
		status: "active",
		limit: 100,
	});
	const workspaceId = spaces[0].id;
	const preferences = await rpc("userSettings/getPreferences", {});
	delete preferences.preferences.activityFeed;
	await rpc("userSettings/updatePreferences", {
		preferences: preferences.preferences,
		expectedRevision: preferences.revision,
	});
	const { data: projects } = await rpc("projects/list", { limit: 100 });
	const projectId = projects[0].id;
	const stamp = Date.now();
	const sources = ["Inbox", "Social"].map((label) => ({
		label,
		workspaceId,
		cardSheetPrefix: `Test ${stamp} ${label} cards `,
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
			name: `Test ${role} ${Date.now()}`,
		});
		const config =
			role === "feed"
				? {
						version: 1,
						scope: "organization",
						projects: [{ id: projectId, label: "Opportunities" }],
						factorySources: sources.map((source) => ({ projectId, source })),
					}
				: {
						version: 1,
						dailyAttentionBudget: 10,
						batchTimesUtc: ["00:00"],
						factorySources: sources,
					};
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
					config,
				},
			},
		);
		installed.push({ gadget: current, currentRevision: revision });
	}
	const native = WorkInteractionInboxRowSchema.parse({
		request: {
			id: "33333333-3333-4333-8333-333333333333",
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
			subject: "Review the fictional native question.",
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
	let verdictPending = false;
	let rejectNextVerdict = false;
	async function fixture(page: Page) {
		await page.route("**/api/rpc/**", async (route) => {
			const path = new URL(route.request().url()).pathname;
			const json = (value: unknown, status = 200) =>
				route.fulfill({
					status,
					contentType: "application/json",
					body: JSON.stringify({ json: value }),
				});
			if (path.endsWith("/osWorkspaces/outputs/setSheetRange")) {
				if (rejectNextVerdict) {
					rejectNextVerdict = false;
					return json(
						{
							defined: false,
							code: "INTERNAL_SERVER_ERROR",
							message: "Fictional save failed",
						},
						500,
					);
				}
				verdictPending = true;
				await new Promise((resolve) => setTimeout(resolve, 600));
				verdictPending = false;
				return route.continue();
			}
			if (path.endsWith("/osWorkspaces/gadgets/workApps"))
				return json({ items: installed, truncated: false });
			const url = new URL(route.request().url());
			const input =
				route.request().method() === "GET"
					? (JSON.parse(url.searchParams.get("data") ?? "{}").json ?? {})
					: (route.request().postDataJSON()?.json ?? {});
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
							title: factory
								? `Review the fictional ${sources[index]!.label.toLowerCase()} opportunity?`
								: "Review the fictional native question?",
							context: factory
								? "Morgan's opportunity is ready for review."
								: "Your supplier needs a delivery date.",
							body: factory
								? "Records whether it is useful; sends nothing."
								: "Saves your date for the reply draft; sends nothing.",
							recommendation:
								"Review first because only you know whether this helps.",
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
	for (const width of [1280, 390])
		for (const theme of ["light", "dark"] as const) {
			const page = await browser.newPage({
				viewport: { width, height: 900 },
				colorScheme: theme,
			});
			await page.addInitScript((mode) => {
				localStorage.setItem("tedix-os-theme", mode);
			}, theme);
			await fixture(page);
			await page.goto(`${origin}/work?view=feed`);
			await page
				.getByRole("link", {
					name: /Review the fictional social opportunity/,
				})
				.waitFor();
			const factoryRow = page.getByRole("article").filter({
				has: page.getByRole("link", {
					name: /Review the fictional social opportunity/,
				}),
			});
			assert(
				!(await factoryRow
					.getByText("Opportunities", { exact: true })
					.isVisible()),
				"factory Feed keeps project context behind Details",
			);
			await factoryRow
				.getByRole("button", { name: "Details", exact: true })
				.click();
			assert(
				await factoryRow
					.getByText("Opportunities", { exact: true })
					.isVisible(),
				"factory Feed Details preserves project context",
			);
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"Feed fits phone and desktop",
			);
			const screenshots = process.env.SOCIAL_CARDS_SCREENSHOTS;
			if (screenshots) {
				await mkdir(screenshots, { recursive: true });
				await page.screenshot({
					path: `${screenshots}/social-cards-feed-${width}-${theme}.png`,
					fullPage: true,
				});
			}
			// Open the ordinary batch, without a factory deep link.
			await page.goto(`${origin}/work?view=deck`);
			await page
				.getByRole("region", {
					name: /Review the fictional (inbox|social) opportunity/,
				})
				.waitFor();
			assert(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= innerWidth,
				),
				"Deck fits phone and desktop",
			);
			if (screenshots)
				await page.screenshot({
					path: `${screenshots}/social-cards-deck-${width}-${theme}.png`,
					fullPage: true,
				});
			await page.close();
		}
	const page = await browser.newPage();
	await fixture(page);
	await page.goto(`${origin}/work?view=feed`);
	await page
		.getByRole("link", {
			name: /Review the fictional social opportunity/,
		})
		.click();
	await page
		.getByRole("region", {
			name: /Review the fictional social opportunity/,
		})
		.waitFor();
	const savedResponse = page.waitForResponse((response) =>
		response.url().includes("/osWorkspaces/outputs/setSheetRange"),
	);
	await page.getByRole("button", { name: "Useful", exact: true }).click();
	await page
		.getByRole("region", {
			name: /Review the fictional inbox opportunity/,
		})
		.waitFor();
	assert(
		!verdictPending,
		"the next factory card is visible after the previous verdict finishes saving",
	);
	await savedResponse;
	const saved = await rpc("osWorkspaces/outputs/get", {
		outputId: sheets[1].output.id,
	});
	assert.equal(
		saved.currentRevision.content.rows[0][
			saved.currentRevision.content.columns.indexOf("Useful?")
		],
		"yes",
		"Deck verdict persists in Social's original row",
	);
	assert.equal(
		saved.currentRevision.content.rows[0][
			saved.currentRevision.content.columns.indexOf("Done?")
		],
		"",
		"Useful does not authorize an action",
	);
	await page.goto(`${origin}/work?view=feed`);
	await page
		.getByRole("link", {
			name: /Review the fictional inbox opportunity/,
		})
		.waitFor();
	assert.equal(
		await page
			.locator(
				`[data-focus-row="factory:${sheets[1].output.id}:0"] .focus-decision-row`,
			)
			.count(),
		0,
		"decided Social row leaves Feed's needs-you links",
	);
	await page.goto(`${origin}/work?view=deck`);
	await page
		.getByRole("region", { name: /Review the fictional inbox opportunity/ })
		.waitFor();
	rejectNextVerdict = true;
	await page.getByRole("button", { name: "Useful", exact: true }).click();
	await page
		.getByText("The verdict was not saved", { exact: true })
		.first()
		.waitFor();
	await page
		.getByRole("region", { name: /Review the fictional inbox opportunity/ })
		.waitFor();
	const unchanged = await rpc("osWorkspaces/outputs/get", {
		outputId: sheets[0].output.id,
	});
	assert.equal(
		unchanged.currentRevision.content.rows[0][
			unchanged.currentRevision.content.columns.indexOf("Useful?")
		],
		"",
		"a failed verdict restores the factory card without changing its cells",
	);

	await page.close();
	console.log(
		"Social/Inbox Feed, ordinary Deck batch, deep link, verdict readback and 390px light/dark checks passed.",
	);
} finally {
	await browser.close();
	if (server) process.kill(-server.pid, "SIGTERM");
}
