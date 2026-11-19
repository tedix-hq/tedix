import assert from "node:assert/strict";
import { chromium, type Browser, type Page, type Request } from "playwright";
import { startFixtureServer } from "./fixture-server";

/**
 * An archived workspace's address says it is archived and when, restores it,
 * and links to Workspaces → Archived. An address with no workspace behind it
 * keeps the "doesn't exist" message and offers neither.
 *
 * Both are modelled on this page only, the way the API answers them: opening
 * is "not found" for either, and the workspace read still returns the
 * archived workspace. Nothing in the shared fixture state changes.
 */
const WORKSPACE_ID = "00000030-0000-4000-8000-000000000002";
const MISSING_ID = "00000030-0000-4000-8000-00000000dead";
const ARCHIVED_AT = "2026-11-12T09:30:00.000Z";

const server = await startFixtureServer("/");
let browser: Browser | undefined;

const notFound = {
	status: 404,
	contentType: "application/json",
	body: JSON.stringify({
		json: { defined: false, code: "NOT_FOUND", message: "Workspace not found" },
	}),
};

async function archiveOnThisPage(page: Page) {
	const state = { archived: true, restores: 0 };
	let workspace: Record<string, unknown> | undefined;
	const names = (request: Request, id: string) =>
		`${decodeURIComponent(request.url())}${request.postData() ?? ""}`.includes(
			id,
		);
	for (const procedure of ["access", "events", "open"])
		await page.route(
			`**/api/rpc/osCollaborators/${procedure}**`,
			async (route) => {
				const request = route.request();
				if (
					names(request, MISSING_ID) ||
					(state.archived && names(request, WORKSPACE_ID))
				)
					return route.fulfill(notFound);
				await route.continue();
			},
		);
	await page.route(
		"**/api/rpc/osWorkspaces/workspaces/get**",
		async (route) => {
			const request = route.request();
			if (names(request, MISSING_ID)) return route.fulfill(notFound);
			if (!names(request, WORKSPACE_ID)) return route.continue();
			const response = await route.fetch();
			const body = await response.json();
			workspace = body.json.workspace;
			if (state.archived) {
				body.json.workspace.status = "archived";
				body.json.workspace.updatedAt = ARCHIVED_AT;
			}
			await route.fulfill({ response, json: body });
		},
	);
	await page.route(
		"**/api/rpc/osWorkspaces/workspaces/restore**",
		async (route) => {
			assert.deepEqual(route.request().postDataJSON().json, {
				workspaceId: WORKSPACE_ID,
			});
			state.restores++;
			state.archived = false;
			await route.fulfill({
				contentType: "application/json",
				body: JSON.stringify({
					json: { workspace: { ...workspace, status: "active" } },
				}),
			});
		},
	);
	return state;
}

try {
	browser = await chromium.launch({ headless: true });
	{
		const width = 375;
		const theme = "light";
		const label = `${width}/${theme}`;
		const context = await browser.newContext({
			viewport: { width, height: 812 },
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		const state = await archiveOnThisPage(page);

		await page.goto(`${server.origin}/workspace/${WORKSPACE_ID}`, {
			waitUntil: "domcontentloaded",
		});
		const notice = page.locator("[data-workspace-archived]");
		await notice.waitFor();
		const text = await notice.innerText();
		assert.match(text, /is archived/, `${label}: says it is archived`);
		const archivedOn = await page.evaluate(
			(at) => new Date(at).toLocaleDateString(),
			ARCHIVED_AT,
		);
		assert(text.includes(`Archived on ${archivedOn}`), `${label}: says when`);
		assert.equal(
			await page.getByText("This workspace doesn't exist").count(),
			0,
			`${label}: an archived workspace is not called missing`,
		);
		assert(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth + 1,
			),
			`${label}: no horizontal page overflow`,
		);

		// The link opens the Archived list, not the active one.
		await page.getByRole("link", { name: "Workspaces → Archived" }).click();
		await page.waitForURL(/\/workspaces\?view=archived$/);
		await page
			.getByText(/archived workspaces/i)
			.first()
			.waitFor();
		await page.goBack();
		await notice.waitFor();

		await page.getByRole("button", { name: "Restore workspace" }).click();
		await page.waitForURL(new RegExp(`/workspace/${WORKSPACE_ID}`));
		// The loading shell and the workspace's own can overlap for a moment.
		await page.locator(".canvas-route-shell:not([aria-busy])").waitFor();
		await notice.waitFor({ state: "detached" });
		assert.equal(state.restores, 1, `${label}: one restore`);
		assert.equal(
			await page.getByText("This workspace doesn't exist").count(),
			0,
			`${label}: the restored workspace opens`,
		);

		// No workspace behind the address: today's message, and nothing more.
		await page.goto(`${server.origin}/workspace/${MISSING_ID}`, {
			waitUntil: "domcontentloaded",
		});
		await page.getByText("This workspace doesn't exist").waitFor();
		await page.getByText("It may have been deleted.").waitFor();
		assert.equal(await notice.count(), 0, `${label}: no archived notice`);
		assert.equal(
			await page.getByRole("button", { name: "Restore workspace" }).count(),
			0,
			`${label}: no Restore for a missing workspace`,
		);
		await context.close();
	}
	console.log("archived workspace: ok");
} finally {
	await browser?.close();
	await server.stop();
}
