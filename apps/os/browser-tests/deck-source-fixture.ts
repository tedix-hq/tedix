import assert from "node:assert/strict";
import type { Page } from "playwright";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { startFixtureServer } from "./fixture-server";

export async function createDeckSourceFixture(scored = false) {
	// Installs Deck sources and sheets in the fixture store, which has no
	// reset, so these specs never share a fixture server with other specs.
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
	const workspaceName: string = spaces[0].name;
	const { data: projects } = await rpc("projects/list", { limit: 100 });
	const projectId = projects[0].id;
	const stamp = Date.now();
	const sources = (scored ? ["Scores"] : ["Inbox", "Social"]).map((label) => ({
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
			score: "Score",
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
						"Score",
					],
					rows: (scored ? [0.2, 0.95, 0.6] : [null]).map((score, rowIndex) => [
						"opportunity",
						`https://example.com/${source.label.toLowerCase()}/${rowIndex}`,
						"Morgan Example",
						scored
							? `Review fictional score ${score}.`
							: `Review the fictional ${source.label.toLowerCase()} opportunity.`,
						"A fictional draft for review.",
						"",
						"",
						"",
						score === null ? "" : String(score),
					]),
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
			subject: scored
				? "Rotate the fictional API key?"
				: "Pick the fictional delivery date.",
			prompt: scored
				? "Rotate the fictional API key?"
				: "Choose a fictional delivery date.",
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
	const title = (index: number, rowIndex = 0) =>
		index >= 0
			? scored
				? `Review fictional score ${[0.2, 0.95, 0.6][rowIndex]}?`
				: `Review the fictional ${sources[index]!.label.toLowerCase()} opportunity?`
			: scored
				? "Rotate the fictional API key?"
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
				const index = sheets.findIndex(({ output }) =>
					input.cardId.startsWith(`factory:${output.id}:`),
				);
				const factory = index >= 0;
				const rowIndex = Number(input.cardId.split(":").at(-1)) || 0;
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
										rowIndex,
										revision: 1,
										draft: "A fictional draft for review.",
										why: "A fictional opportunity is ready.",
										sourceText: "Morgan Example",
									},
								}
							: { interaction: native }),
						presentation: {
							version: 2,
							title: title(index, rowIndex),
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

	return {
		origin,
		fixture,
		workspaceName,
		title,
		close: server.stop,
	};
}

export async function chooseSource(page: Page, label: string) {
	const chip = page.getByRole("combobox", { name: "Card source" });
	// Phones keep the Deck's filters behind one Filters button.
	const filters = page.getByRole("button", { name: "Filters" });
	await chip.or(filters).first().waitFor();
	const phone = !(await chip.isVisible());
	for (
		let tries = 0;
		phone && !(await chip.isVisible()) && tries < 3;
		tries++
	) {
		await filters.click();
		await chip.waitFor({ timeout: 2_000 }).catch(() => {});
	}
	await chip.click();
	await page.getByRole("option", { name: label, exact: true }).click();
	await page.getByRole("listbox").waitFor({ state: "hidden" });
	if (phone && (await chip.isVisible())) {
		await page.keyboard.press("Escape");
		await chip.waitFor({ state: "hidden" });
	}
}
