import assert from "node:assert/strict";
import { chromium, type Locator, type Page } from "playwright";
import { startFixtureServer } from "./fixture-server";

/*
 * Agents from the chat page of a workspace on a phone (375 x 812):
 * - the conversation list keeps what people started; a conversation an agent
 *   started is not in it;
 * - Files opens Agents, where that run is listed as needing the person and
 *   Review opens it;
 * - a list that is empty only because agents started every conversation says
 *   the agents' ones are under Agents;
 * - every control on the way is at least 44px, and nothing scrolls sideways.
 */
const workspaceId = "00000030-0000-4000-8000-000000000001";
const workspace = `/workspace/${workspaceId}`;
const WIDTH = 375;
// The address keeps a conversation only when its id is a UUID.
const RUN = "00000031-0000-4000-8000-000000000002";

type Row = Record<string, unknown>;
const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();
const own: Row = {
	id: "00000031-0000-4000-8000-000000000001",
	title: "Plan the launch",
	updatedAt: minutesAgo(5),
	lastTurnAt: minutesAgo(5),
};
const agentRun: Row = {
	id: RUN,
	title: "Nightly import",
	updatedAt: minutesAgo(3),
	lastTurnAt: minutesAgo(3),
	pendingApprovals: 1,
	startedBy: { kind: "agent", id: "app:import" },
};

const server = await startFixtureServer("/");
const browser = await chromium.launch({ headless: true });

/** The workspace's chat lane, answering with these conversations. */
async function chatWith(page: Page, conversations: Row[]) {
	await page.routeWebSocket(
		(url) => url.pathname === `${workspace}/chat`,
		(socket) => {
			socket.onMessage((raw) => {
				const frame = JSON.parse(String(raw));
				if (frame.type !== "subscribe") return;
				socket.send(
					JSON.stringify({
						type: "hello",
						waiting: [],
						serverTime: new Date().toISOString(),
						cursor: 1,
						conversations,
					}),
				);
				socket.send(
					JSON.stringify({
						type: "caught_up",
						conversationId: frame.conversationId,
					}),
				);
			});
		},
	);
}

async function thumbSized(
	page: Page,
	name: string | RegExp,
	where: string,
	scope: Page | Locator = page,
) {
	const control = scope.getByRole("button", { name }).first();
	await control.waitFor();
	const box = await control.boundingBox();
	assert(
		box && box.width >= 44 && box.height >= 44,
		`${where}: "${name}" is at least 44px: ${JSON.stringify(box)}`,
	);
	return control;
}

/** Files is the one entry to Agents; both steps are thumb-sized. */
async function openAgents(page: Page) {
	await (
		await thumbSized(
			page,
			"Files",
			"workspace pane tabs",
			page.getByRole("group", { name: "Workspace pane" }),
		)
	).tap();
	await page.waitForURL(/pane=files/);
	const entry = page.locator("[data-workspace-outputs-agents]");
	await entry.waitFor();
	const box = await entry.boundingBox();
	assert(
		box && box.width >= 44 && box.height >= 44,
		`Files: "Agents" is at least 44px: ${JSON.stringify(box)}`,
	);
	await entry.tap();
	await page.waitForURL(/pane=agents/);
}

const noSidewaysScroll = async (page: Page, where: string) =>
	assert.equal(
		await page.evaluate(() => document.documentElement.scrollWidth),
		WIDTH,
		`${where}: the page is exactly as wide as the phone`,
	);

try {
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: 812 },
		reducedMotion: "reduce",
		isMobile: true,
		hasTouch: true,
	});

	// A person's conversation and an agent's run that waits for a decision.
	const page = await context.newPage();
	page.setDefaultTimeout(15_000);
	await chatWith(page, [agentRun, own]);
	await page.goto(`${server.origin}${workspace}?pane=chat`, {
		waitUntil: "domcontentloaded",
	});
	await (await thumbSized(page, "All conversations", "chat")).tap();
	const list = page.locator(".workspace-chat-list");
	await list.getByText("Plan the launch").waitFor();
	assert.equal(
		await list.getByText("Nightly import").count(),
		0,
		"a conversation an agent started is not in the person's list",
	);
	assert.equal(
		await page.locator(".canvas-surface").count(),
		0,
		"this is the phone chat page, not the workspace with its panes",
	);
	// The same two tabs as the workspace, so nothing moves between pages.
	assert.deepEqual(
		await page
			.getByRole("group", { name: "Workspace pane" })
			.getByRole("button")
			.allInnerTexts(),
		["Chat", "Files"],
	);
	await noSidewaysScroll(page, "conversation list");
	await openAgents(page);

	// Agents lists the run under its agent; Review opens it in the chat.
	const agents = page.getByRole("region", { name: "Workspace agents" });
	const agent = agents.locator('[data-workspace-agent="agent:app:import"]');
	await agent.getByText("1 needs you").waitFor();
	const row = agent.getByRole("button", { expanded: false });
	const rowBox = await row.boundingBox();
	assert(rowBox && rowBox.height >= 44, "an agent's row is at least 44px tall");
	await row.tap();
	await agent
		.locator(`[data-agent-run="${RUN}"][data-agent-run-state="needs_you"]`)
		.waitFor();
	// Agents opens under Files; the tabs stay Chat and Files.
	await page
		.getByRole("group", { name: "Workspace pane" })
		.getByRole("button", { name: "Files", pressed: true })
		.waitFor();
	await noSidewaysScroll(page, "agents");
	await (await thumbSized(page, "Review Nightly import", "agents")).tap();
	await page.waitForURL(new RegExp(`conversation=${RUN}`));
	assert.match(page.url(), /pane=chat/);
	await page
		.locator(".workspace-chat-header")
		.getByText("Nightly import")
		.waitFor();
	await page.close();

	// Agents started every conversation: the list says so and offers Agents.
	const quiet = await context.newPage();
	quiet.setDefaultTimeout(15_000);
	await chatWith(quiet, [{ ...agentRun, pendingApprovals: 0 }]);
	await quiet.goto(`${server.origin}${workspace}?pane=chat`, {
		waitUntil: "domcontentloaded",
	});
	await quiet.getByRole("button", { name: "All conversations" }).tap();
	await quiet.getByText("No conversations of your own here").waitFor();
	await quiet.getByText("The ones agents started are under Agents.").waitFor();
	assert.equal(await quiet.getByText("Nightly import").count(), 0);
	await noSidewaysScroll(quiet, "empty list");
	await openAgents(quiet);
	await quiet
		.getByRole("region", { name: "Workspace agents" })
		.locator('[data-workspace-agent="agent:app:import"]')
		.waitFor();

	await context.close();
	console.log(
		"PASS agents from the phone chat page: own list, Agents from Files, Review, empty list",
	);
} finally {
	await browser.close();
	await server.stop();
}
