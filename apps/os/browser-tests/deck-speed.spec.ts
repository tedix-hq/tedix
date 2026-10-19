import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, webkit, devices, type Page, type Browser } from "playwright";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
const baseline = process.env.DECK_SPEED_BASELINE === "1";
const cwd =
	process.env.DECK_SPEED_CWD ?? new URL("../", import.meta.url).pathname;
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
	{ cwd, stdout: "ignore", stderr: "inherit", detached: true },
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
		dailyAttentionBudget: 10,
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
		subject: `Speed card ${n}`,
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
				proposal: `Speed card ${n}`,
				classId: "speed",
				protectedEffects: [],
				reversibility: "two_way",
			},
		},
	};
}
async function fixture(page: Page, failure = false) {
	const decided = new Set<string>();
	const requests = Array.from({ length: 6 }, (_, i) => request(i + 1));
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
		if (path.endsWith("/workInteractions/listInbox"))
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
			if (failure)
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
async function open(page: Page) {
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (error) =>
		console.error("Browser error:", error.message),
	);
	await page.goto(`${origin}/work?view=deck`);
	try {
		await page
			.getByRole("region", { name: "Speed card 1", exact: true })
			.waitFor();
	} catch (error) {
		console.error((await page.locator("body").innerText()).slice(-5000));

		throw error;
	}
	await page.waitForTimeout(350);
}
async function measure(page: Page) {
	return page.evaluate(
		() =>
			new Promise<number>((resolve, reject) => {
				const card = document.querySelector<HTMLElement>(
					'.fd-decision[aria-label="Speed card 1"]',
				)!;
				const button = [
					...card.querySelectorAll<HTMLButtonElement>("button"),
				].find((node) => node.textContent?.trim().startsWith("Approve"))!;
				const start = performance.now(),
					timeout = setTimeout(
						() => reject(new Error("Next card timed out")),
						8000,
					);
				const check = () => {
					const next = document.querySelector<HTMLElement>(
						'.fd-decision[aria-label="Speed card 2"]',
					);
					if (
						next &&
						Number(getComputedStyle(next).opacity) > 0.9 &&
						next.getBoundingClientRect().height > 0
					) {
						clearTimeout(timeout);
						resolve(performance.now() - start);
					} else requestAnimationFrame(check);
				};
				button.click();
				requestAnimationFrame(check);
			}),
	);
}
let browser: Browser | undefined;
const results: Record<string, unknown> = {
	baseline,
	apiDelayMs: 500,
	viewport: "390x844",
};
try {
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		await Bun.sleep(250);
	}
	browser = await chromium.launch();
	const times: number[] = [];
	for (let i = 0; i < 5; i++) {
		const context = await browser.newContext({
				viewport: { width: 390, height: 844 },
				isMobile: true,
				hasTouch: true,
			}),
			page = await context.newPage();
		await fixture(page);
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		await open(page);
		times.push(await measure(page));
		await context.close();
	}
	results.chromium4xMs = times;
	console.log("Latency", times);
	if (!baseline) assert(Math.max(...times) < 100, `Next card <100ms: ${times}`);
	const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
		}),
		page = await context.newPage();
	await fixture(page);
	await open(page);
	let requests = 0;
	const requestPaths: Record<string, number> = {};
	page.on("request", (request) => {
		const path = new URL(request.url()).pathname;
		if (!path.startsWith("/api/rpc/")) return;
		requests++;
		requestPaths[path] = (requestPaths[path] ?? 0) + 1;
	});
	const pollWindowMs = Number(process.env.DECK_SPEED_POLL_MS ?? 121_000);
	await page.waitForTimeout(pollWindowMs);
	results.pollWindowMs = pollWindowMs;
	results.workRequestsPerMinute = pollWindowMs
		? (requests * 60_000) / pollWindowMs
		: null;
	results.workRequestsInWindow = requests;
	results.requestPaths = { ...requestPaths };
	if (!baseline) {
		for (let focus = 0; focus < 2; focus++) {
			await Promise.all([
				page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname.endsWith(
							"/workInteractions/listInbox",
						) && response.ok(),
				),
				page.evaluate(() => window.dispatchEvent(new Event("focus"))),
			]);
			await page.waitForTimeout(100);
		}
		results.repeatedFocusRefresh =
			"both window focus events refetched the inbox";
		const cdp = await context.newCDPSession(page);
		results.installability = await cdp.send("Page.getInstallabilityErrors");
		const response = await page.request.get(`${origin}/manifest.webmanifest`);
		assert(
			response.headers()["content-type"].includes("application/manifest+json"),
		);
		const manifest = await response.json();
		assert.equal(manifest.start_url, "/work");
		assert.equal(manifest.display, "standalone");
		assert.deepEqual(
			(results.installability as { installabilityErrors: unknown[] })
				.installabilityErrors,
			[],
		);
		assert.equal(
			await page
				.locator('meta[name="apple-mobile-web-app-capable"]')
				.getAttribute("content"),
			"yes",
		);
	}
	await context.close();
	await browser.close();
	browser = undefined;
	if (!baseline) {
		browser = await webkit.launch();
		const context = await browser.newContext({
				...devices["iPhone 13"],
				viewport: { width: 390, height: 844 },
			}),
			page = await context.newPage();
		await fixture(page, true);
		await open(page);
		results.webkitMs = await measure(page);
		assert(Number(results.webkitMs) < 100);
		const card = page.getByRole("region", {
			name: "Speed card 1",
			exact: true,
		});
		await card.waitFor();
		await page
			.getByText("Fictional save failed", { exact: true })
			.first()
			.waitFor();
		for (const [dx, dy] of [
			[60, 0],
			[100, 80],
		]) {
			await card.dispatchEvent("pointerdown", {
				pointerType: "touch",
				pointerId: 1,
				isPrimary: true,
				button: 0,
				clientX: 50,
				clientY: 250,
			});
			await card.dispatchEvent("pointermove", {
				pointerType: "touch",
				pointerId: 1,
				isPrimary: true,
				clientX: 50 + dx!,
				clientY: 250 + dy!,
			});
			await card.dispatchEvent("pointerup", {
				pointerType: "touch",
				pointerId: 1,
				isPrimary: true,
				clientX: 50 + dx!,
				clientY: 250 + dy!,
			});
			assert(
				await card.isVisible(),
				"short and vertical gestures keep the card",
			);
		}
		assert.equal(
			await card.evaluate((node) => getComputedStyle(node).touchAction),
			"pan-y",
		);
		await card.dispatchEvent("pointerdown", {
			pointerType: "touch",
			pointerId: 1,
			isPrimary: true,
			button: 0,
			clientX: 50,
			clientY: 250,
		});
		await card.dispatchEvent("pointermove", {
			pointerType: "touch",
			pointerId: 1,
			isPrimary: true,
			clientX: 180,
			clientY: 254,
		});
		assert.equal(
			await card.evaluate((node) =>
				(node as HTMLElement).style.getPropertyValue("--fd-drag"),
			),
			"130px",
		);
		await card.dispatchEvent("pointerup", {
			pointerType: "touch",
			pointerId: 1,
			isPrimary: true,
			clientX: 180,
			clientY: 254,
		});
		await page
			.getByRole("region", { name: "Speed card 2", exact: true })
			.waitFor();
		await card.waitFor();
		results.webkitSwipe =
			"short/vertical gestures keep card; right swipe advances; failed writes restore card with toast";
		await context.close();
	}
	console.log(JSON.stringify(results, null, 2));
	if (process.env.DECK_SPEED_RESULTS)
		await Bun.write(
			process.env.DECK_SPEED_RESULTS,
			JSON.stringify(results, null, 2) + "\n",
		);
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await server.exited;
}
