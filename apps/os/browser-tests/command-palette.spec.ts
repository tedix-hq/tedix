import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chromium, type Browser } from "playwright";

const cwd = new URL("../", import.meta.url).pathname;
const probe = createServer();
await new Promise<void>((resolve, reject) => {
	probe.once("error", reject);
	probe.listen(0, "127.0.0.1", resolve);
});
const address = probe.address();
assert(address && typeof address !== "string");
const port = String(address.port);
await new Promise<void>((resolve, reject) => {
	probe.close((error) => (error ? reject(error) : resolve()));
});
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
let browser: Browser | undefined;
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		if (server.exitCode !== null)
			throw new Error(`Vite exited: ${server.exitCode}`);
		try {
			ready = (await fetch(origin)).ok;
		} catch {}
		if (ready) break;
		await Bun.sleep(250);
	}
	assert(ready, "fixture server starts");
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
		"Search pages, workspaces, outputs, apps, skills…",
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
	try {
		process.kill(-server.pid, "SIGTERM");
	} catch {
		server.kill();
	}
	await server.exited;
}
