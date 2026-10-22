import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// Keys typed into the Tedi chat widget (an open Shadow DOM host) must stay
// text: the Feed, Today and context-rail page shortcuts never see them.
const typed = "help me with jkoph n it?";
const server = await startFixtureServer();
const { origin } = server;
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1440, height: 1000 },
		reducedMotion: "reduce",
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("https://widget.tedix.dev/**", (route) =>
		route.fulfill({
			contentType: "application/javascript",
			body: `window.Tedix ??= (() => { const listeners = new Map(); let host; return {
 on(event, listener) { listeners.set(event, listener); return () => listeners.delete(event); },
 init() {
  host = document.createElement('div'); host.dataset.tedixWidget = '';
  host.attachShadow({mode:'open'}).innerHTML = '<button class="tedix-launcher" aria-label="Quick chat">✦</button><form><textarea aria-label="Message Tedi"></textarea></form>';
  document.body.append(host); listeners.get('ready')?.({});
 }, context() {}, shutdown() { host?.remove(); }
}; })();`,
		}),
	);
	await page.route("**/api/rpc/osWorkspaces/gadgets/workApps", (route) =>
		route.fulfill({
			json: {
				json: {
					items: [
						{
							gadget: {
								id: "00000050-0000-4000-8000-000000000001",
								workspaceId: "00000030-0000-4000-8000-000000000001",
								name: "Activity",
								status: "active",
							},
							currentRevision: {
								manifest: {
									entry: "tedix:app/activity-feed",
									navigation: { work: "feed" },
									capabilities: [],
									config: { version: 1, scope: "organization", projects: [] },
								},
							},
						},
					],
					truncated: false,
				},
			},
		}),
	);
	await page.route(
		"**/api/rpc/workInteractions/refreshDecisionSources",
		(route) =>
			route.fulfill({
				json: {
					json: { created: 0, superseded: 0, scanned: 0, hasMore: false },
				},
			}),
	);
	await page.goto(`${origin}/work?view=feed`);
	await page.locator(".focus-feed").waitFor();
	await page.locator("[data-focus-row]").first().waitFor();
	await page.locator(":root[data-quick-chat-launcher]").waitFor();
	await page.evaluate(() => {
		document.body.dataset.shortcutClicks = "[]";
		document.addEventListener(
			"click",
			(event) => {
				const node = (event.target as Element).closest?.(
					"[data-focus-row] a,[data-focus-row] button",
				);
				if (!node) return;
				const clicks = JSON.parse(document.body.dataset.shortcutClicks!);
				clicks.push(node.getAttribute("aria-label") ?? "open");
				document.body.dataset.shortcutClicks = JSON.stringify(clicks);
				event.preventDefault();
				event.stopImmediatePropagation();
			},
			true,
		);
	});
	const before = await page.evaluate(() => ({
		url: location.href,
		scroll: document.querySelector('.route-content [data-slot="page"]')
			?.scrollTop,
		context: document.querySelectorAll("[data-decision-context]").length,
	}));
	const input = page.locator("[data-tedix-widget] textarea");
	await input.click();
	await page.keyboard.type(typed);
	assert.equal(await input.inputValue(), typed, "Widget keeps every key");
	assert(
		await page.evaluate(
			() =>
				document.activeElement?.matches("[data-tedix-widget]") &&
				document.activeElement.shadowRoot?.activeElement?.tagName ===
					"TEXTAREA",
		),
		"Focus stays in the widget input",
	);
	assert.deepEqual(
		await page.evaluate(() =>
			JSON.parse(document.body.dataset.shortcutClicks!),
		),
		[],
		"No Feed row action fired",
	);
	const after = await page.evaluate(() => ({
		url: location.href,
		scroll: document.querySelector('.route-content [data-slot="page"]')
			?.scrollTop,
		context: document.querySelectorAll("[data-decision-context]").length,
	}));
	assert.deepEqual(after, before, "No page shortcut changed the page");
	assert.equal(
		await page.locator("[role=dialog]").count(),
		0,
		"No shortcut dialog opened",
	);
	assert.deepEqual(errors, [], "No page errors");
	console.log("Widget typing never triggers page shortcuts");
} finally {
	await browser?.close();
	await server.stop();
}
