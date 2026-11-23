import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixture-server";

const server = await startFixtureServer("/", { shared: false });
const origin = server.origin;
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	const createWorkspace = async (name: string) => {
		const response = await page.request.post(
			`${origin}/api/rpc/osWorkspaces/workspaces/create`,
			{
				data: { json: { name } },
			},
		);
		assert.equal(response.status(), 200);
		return (await response.json()).json.workspace;
	};
	// Put the target beyond both the palette page and the API's maximum page size.
	for (let i = 0; i < 205; i++) {
		await createWorkspace(`AA Workspace ${String(i).padStart(3, "0")}`);
	}
	const target = await createWorkspace("Tedix Books Reference");
	const first = await page.request.post(
		`${origin}/api/rpc/osWorkspaces/workspaces/list`,
		{
			data: { json: { status: "active", limit: 200 } },
		},
	);
	const firstPage = (await first.json()).json;
	assert(firstPage.truncated);
	assert(!firstPage.items.some((row: { id: string }) => row.id === target.id));
	await page.goto(origin);
	await page.getByText("Quick search…", { exact: true }).click();
	const input = page.getByPlaceholder(
		"Search pages, workspaces, documents, apps, skills…",
	);
	for (const query of ["book", "BOOKS reference", "tedix", "reference"]) {
		await input.fill(query);
		await page.getByText(target.name, { exact: true }).waitFor();
		console.log(
			`${query} finds ${target.name} beyond the first 200 workspaces`,
		);
	}
	await input.fill("book");
	assert.equal(
		await page
			.getByRole("option", { name: target.name })
			.locator("mark")
			.first()
			.textContent(),
		"Book",
	);
	console.log("The matched part of a result is highlighted");

	// Outside a workspace a new file asks where it goes.
	await input.fill("new sheet");
	await page.getByRole("option", { name: /New sheet/ }).click();
	const sheetDialog = page.getByRole("dialog", { name: "New Sheet" });
	await sheetDialog.getByLabel("Workspace").first().waitFor();
	await page.keyboard.press("Escape");
	await sheetDialog.waitFor({ state: "hidden" });
	console.log("New sheet asks for a workspace outside one");

	await page.getByText("Quick search…", { exact: true }).click();
	await input.fill("new workspace");
	await page.getByRole("option", { name: /New workspace/ }).click();
	const workspaceDialog = page.getByRole("dialog", {
		name: "Create workspace",
	});
	await workspaceDialog.waitFor();
	await page.keyboard.press("Escape");
	await workspaceDialog.waitFor({ state: "hidden" });
	console.log("New workspace opens the create dialog");

	await page.getByText("Quick search…", { exact: true }).click();
	await input.fill("reference");
	await page.getByText(target.name, { exact: true }).click();
	await page.waitForURL(`**/workspace/${target.id}`);
	console.log("Selected workspace opens its Canvas");

	// Before anything is typed the workspace opened last comes first.
	const preferences = (
		await (
			await page.request.post(
				`${origin}/api/rpc/osWorkspaces/workspacePreferences/list`,
				{ data: { json: {} } },
			)
		).json()
	).json.items as { workspaceId: string; lastOpenedAt: string | null }[];
	const latest = preferences
		.filter((row) => row.lastOpenedAt)
		.sort((a, b) => b.lastOpenedAt!.localeCompare(a.lastOpenedAt!))[0];
	assert(latest, "The sample data has a workspace that was opened");
	await page.goto(origin);
	await page.getByText("Quick search…", { exact: true }).click();
	await page.getByText("Recent workspaces", { exact: true }).waitFor();
	await page.getByRole("option").first().click();
	await page.waitForURL(`**/workspace/${latest.workspaceId}*`);
	await page.getByLabel("Search workspace", { exact: true }).first().waitFor();
	console.log("The workspace opened last leads the empty palette");

	// Inside a workspace a new file is created there without asking where.
	await page.keyboard.press("ControlOrMeta+k");
	await input.fill("new doc");
	await page.getByRole("option", { name: /in this workspace/ }).click();
	const docDialog = page.getByRole("dialog", { name: "New Doc" });
	await docDialog.waitFor();
	assert.equal(await docDialog.getByLabel("Workspace").count(), 0);
	await docDialog.getByPlaceholder("Untitled document").fill("Palette notes");
	await docDialog.getByRole("button", { name: "Create Doc" }).click();
	await page.waitForURL(
		(url) =>
			url.pathname === `/workspace/${latest.workspaceId}` &&
			(url.searchParams.get("workpiece") ?? "").startsWith("gadget:"),
	);
	await docDialog.waitFor({ state: "hidden" });
	console.log("New doc creates the document in the workspace on screen");
} finally {
	await browser?.close();
	await server.stop();
}
