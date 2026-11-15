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
	await page.getByText(target.name, { exact: true }).click();
	await page.waitForURL(`**/workspace/${target.id}`);
	console.log("Selected workspace opens its Canvas");
} finally {
	await browser?.close();
	await server.stop();
}
