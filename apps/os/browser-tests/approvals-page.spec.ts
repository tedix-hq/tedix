import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, type Browser, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * The Approvals page inside the real OS shell, with 30 waiting requests and
 * one expired one: every card's Approve button can be scrolled to and tapped
 * (nothing such as the phone tab bar or the chat button covers it), the count
 * matches the list, nothing scrolls sideways, and one tap approves with a
 * visible confirmation. WebKit and Chromium, 375 and 1280 px, light and dark.
 */
const PATH = "/work/approvals";
const WAITING = 30;
const server = await startFixtureServer(PATH);
const evidenceDir = process.env.APPROVALS_PAGE_EVIDENCE_DIR;
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

const HOUR = 3_600_000;

function request(index: number, expiresInHours: number) {
	const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
	return {
		id,
		tediId: "00000000-0000-4000-8000-0000000000aa",
		orgId: "00000000-0000-4000-8000-0000000000bb",
		actionType: "home.tool_write",
		description: `Create 1 Work item in Example research: "Example task ${index}"`,
		payload: {
			kind: "home_tool_write",
			appSlug: "example",
			toolName: "work.create_work_items",
			riskTier: index % 3 === 0 ? "low" : "medium",
			conversationId: `home:os:example-${index}`,
			args: { title: `Example task ${index}` },
		},
		status: "pending",
		createdAt: new Date(Date.now() - 2 * HOUR).toISOString(),
		expiresAt: new Date(Date.now() + expiresInHours * HOUR).toISOString(),
		resolvedAt: null,
		resolvedBy: null,
		resolution: null,
		workflowId: null,
		review: {
			intent: "tool_write",
			state: "requires_decision",
			decisionMode: "approve_or_reject",
			outcome: null,
			safetyDefault: "deny_on_timeout",
			summary: `Create 1 Work item in Example research: "Example task ${index}"`,
			operatorQuestion: "Approve or reject this Home tool write.",
			timeout: {
				expired: expiresInHours < 0,
				terminalStatus: null,
				defaultDecision: null,
				reason: "",
			},
			evidenceRefs: [],
			interaction: null,
		},
	};
}

async function seed(page: Page) {
	const decided = new Set<string>();
	const rows = [
		...Array.from({ length: WAITING }, (_, index) => request(index, 1 + index)),
		request(WAITING, -30),
	];
	await page.route("**/api/rpc/tediApprovals/list**", async (route) => {
		// The waiting list asks for status "pending"; History asks for every state.
		const pending =
			`${decodeURIComponent(route.request().url())}${route.request().postData() ?? ""}`.includes(
				"pending",
			);
		const data = rows.filter((row) => !decided.has(row.id));
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					data: pending ? data : [],
					pagination: {
						limit: 100,
						offset: 0,
						total: pending ? data.length : 0,
						hasMore: false,
					},
				},
			}),
		});
	});
	await page.route("**/api/rpc/tediApprovals/resolve", async (route) => {
		const input = JSON.parse(route.request().postData() ?? "{}") as {
			json?: { id?: string; status?: string };
		};
		const row = rows.find((entry) => entry.id === input.json?.id);
		if (row) decided.add(row.id);
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				json: { ...row, status: input.json?.status ?? "approved" },
			}),
		});
	});
}

async function settle(page: Page) {
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	);
}

/** The Approve button's centre is on screen and nothing sits on top of it. */
async function reachable(page: Page, index: number) {
	const card = page.locator("[data-approval-card]").nth(index);
	const button = card.getByRole("button", { name: "Approve", exact: true });
	await button.scrollIntoViewIfNeeded();
	await settle(page);
	const hit = await button.evaluate((node) => {
		const box = node.getBoundingClientRect();
		const x = box.left + box.width / 2;
		const y = box.top + box.height / 2;
		const top = document.elementFromPoint(x, y);
		return {
			inside: y > 0 && y < window.innerHeight && x > 0 && x < window.innerWidth,
			covered: !(top && node.contains(top)),
			by:
				top && !node.contains(top)
					? `${top.tagName}.${String(top.className).slice(0, 80)}`
					: null,
		};
	});
	assert.equal(hit.inside, true, `Card ${index} Approve is on screen`);
	assert.equal(
		hit.covered,
		false,
		`Card ${index} Approve is not covered (covered by ${hit.by})`,
	);
}

const browsers: Browser[] = [];
try {
	for (const engine of [webkit, chromium]) {
		const browser = await engine.launch();
		browsers.push(browser);
		for (const theme of ["light", "dark"] as const)
			for (const [width, height] of [
				[375, 812],
				[1280, 900],
			] as const) {
				const page = await browser.newPage({
					viewport: { width, height },
					colorScheme: theme,
					hasTouch: width < 820,
				});
				page.setDefaultTimeout(20_000);
				await seed(page);
				await page.goto(`${server.origin}${PATH}`);
				const cards = page.locator("[data-approval-card]");
				await cards.first().waitFor();
				await page.getByText(`${WAITING} waiting`).first().waitFor();
				assert.equal(await cards.count(), WAITING, "Every request has a card");
				assert.equal(
					await page.getByText("Expired · 1").count(),
					1,
					"The expired request is listed apart",
				);
				for (const jargon of [
					"Decide for me",
					"Choose veto",
					"Remove from review",
					"hard dependency graph",
				])
					assert.equal(await page.getByText(jargon).count(), 0, jargon);
				const sideways = await page.evaluate(
					() =>
						document.documentElement.scrollWidth >
						document.documentElement.clientWidth,
				);
				assert.equal(sideways, false, "No horizontal scroll");
				for (let index = 0; index < WAITING; index += 1)
					await reachable(page, index);
				// The last card can sit fully above the bottom chrome.
				await page
					.getByRole("button", { name: "Clear expired" })
					.scrollIntoViewIfNeeded();
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/${engine.name()}-${width}-${theme}-end.png`,
					});
				await page.evaluate(() => window.scrollTo(0, 0));
				await page
					.locator("main")
					.evaluate((node) => node.scrollTo?.(0, 0))
					.catch(() => undefined);
				const first = cards.first();
				const title = (await first.locator("h3").textContent()) ?? "";
				await first
					.getByRole("button", { name: "Approve", exact: true })
					.click();
				// The card leaves the list, so the result is a toast shown wherever
				// the person scrolled to.
				await page
					.locator("[data-os-toast-outlet]")
					.getByText(/^Approved: Create 1 Work item in Example research/)
					.waitFor();
				await page
					.getByText(`${WAITING - 1} waiting`)
					.first()
					.waitFor();
				assert.equal(
					await page.getByRole("heading", { name: title, exact: true }).count(),
					0,
					"The approved card leaves the list",
				);
				if (evidenceDir)
					await page.screenshot({
						path: `${evidenceDir}/${engine.name()}-${width}-${theme}-approved.png`,
					});
				await page.close();
			}
	}
	console.log(
		"approvals page: every card reachable, one-tap approve confirmed",
	);
} finally {
	await Promise.all(browsers.map((browser) => browser.close()));
	await server.stop();
}
