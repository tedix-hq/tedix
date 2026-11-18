import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

// A person with no workspace yet sees template cards in the workspace list and
// starts a workspace from one in a single click.
const server = await startFixtureServer("/workspaces", { shared: false });
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	for (const width of [1280, 375]) {
		const page = await browser.newPage({ viewport: { width, height: 812 } });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		// Quick Chat mounts with the shell; its branding must stay local.
		await page.route("**/widget/branding/*", (route) =>
			route.fulfill({ json: { branding: {} } }),
		);
		// A brand-new account: the fixture's workspaces are hidden from the list.
		const listRoute = "**/api/rpc/osWorkspaces/workspaces/list";
		await page.route(listRoute, (route) =>
			route.fulfill({ json: { json: { items: [], truncated: false } } }),
		);
		await page.goto(`${server.origin}/workspaces`);
		await page.getByText("No workspaces yet", { exact: true }).waitFor();
		await page
			.getByRole("heading", { name: "Start from a template", exact: true })
			.waitFor();
		const start = page.getByRole("button", {
			name: "Start a workspace from Revenue Ops Starter",
			exact: true,
		});
		await start.waitFor();
		assert.equal(await start.innerText(), "Use this template");
		assert.ok(
			await page.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth + 1,
			),
			`no horizontal overflow at ${width}px`,
		);

		if (width === 375) {
			// Someone else already has a workspace with the template's name.
			await page.route(
				"**/api/rpc/osWorkspaces/blueprints/instantiateFromGallery",
				(route) =>
					route.fulfill({
						status: 409,
						json: {
							json: {
								defined: false,
								code: "CONFLICT",
								message: "Workspace name already taken",
							},
						},
					}),
			);
		}
		await start.click();
		if (width === 1280) {
			// The fixture creates the workspace and the person lands in it.
			await page.waitForURL(/\/workspace\/[0-9a-f-]{36}/);
			const workspaceId = new URL(page.url()).pathname.split("/")[2];
			const created = await page.request.post(
				`${server.origin}/api/rpc/osWorkspaces/workspaces/get`,
				{ data: { json: { workspaceId } } },
			);
			assert.equal(created.status(), 200);
			assert.equal(
				(await created.json()).json.workspace.name,
				"Revenue Ops Starter",
			);
			console.log(
				"PASS 1280px: a template card starts a workspace in one click",
			);
		} else {
			// The page says the name is taken and links to the naming step.
			await page
				.getByText("Couldn't create the workspace", { exact: true })
				.waitFor();
			await page
				.getByText("A workspace named “Revenue Ops Starter” already exists.")
				.waitFor();
			const setup = page.getByRole("link", {
				name: "Pick another name",
				exact: true,
			});
			assert.match(
				(await setup.getAttribute("href")) ?? "",
				/^\/blueprints\?view=explore&install=[0-9a-f-]{36}$/,
			);
			assert.equal(new URL(page.url()).pathname, "/workspaces");
			console.log(
				"PASS 375px: a taken name says so and links to the naming step",
			);
		}
		assert.deepEqual(errors, []);
		await page.close();
	}
} finally {
	await browser?.close();
	await server.stop();
}
