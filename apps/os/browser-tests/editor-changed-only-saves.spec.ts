import assert from "node:assert/strict";
import { chromium, type Browser, type WebSocketRoute } from "playwright";
import { buildDocBlueprint } from "@tedix/api-contract/assets/doc-blueprint";
import { startFixtureServer } from "./fixture-server";

// A Doc open in a workspace, in a real browser and the real sandbox: typing
// saves a moment later by sending only the changed block, the saved file then
// holds the text, and nothing sends or re-reads the whole document.
const workspaceId = "00000030-0000-4000-8000-000000000001";
const outputId = "00000040-0000-4000-8000-000000000001";

// The save writes fixture state, so this spec owns its server.
const server = await startFixtureServer("/", { shared: false });
let browser: Browser | undefined;

try {
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		reducedMotion: "reduce",
	});
	const page = await context.newPage();
	page.setDefaultNavigationTimeout(120_000);
	const rpc = async (method: string, input: unknown) => {
		const response = await page.request.post(
			`${server.origin}/api/rpc/${method}`,
			{ data: { json: input } },
		);
		assert(response.ok(), `${method}: ${await response.text()}`);
		return (await response.json()).json;
	};
	const { gadget } = await rpc("osWorkspaces/gadgets/installOutputEditor", {
		workspaceId,
		outputId,
		kind: "document",
	});
	// The local lane installs a placeholder editor. Give the app the real Doc
	// editor, exactly as an organization's workspace runs it.
	const installed = await rpc("osWorkspaces/gadgets/get", {
		workspaceId,
		gadgetId: gadget.id,
	});
	const slot = installed.currentRevision.manifest.config.settings.slot;
	const doc = buildDocBlueprint(slot).gadgets![0]!;
	await rpc("osWorkspaces/gadgets/revise", {
		workspaceId,
		gadgetId: gadget.id,
		manifest: doc.manifest,
		files: doc.files,
	});
	const before = await rpc("osWorkspaces/outputs/get", { outputId });
	// The fixture API has no live room. Deliver its real save's notice to both
	// tabs over the same WebSocket frames as the production room, before the
	// saving tab receives its HTTP reply.
	const rooms = new Set<WebSocketRoute>();
	await context.routeWebSocket("**/collab/*/workspace%3A*", (socket) => {
		rooms.add(socket);
		socket.onClose(() => rooms.delete(socket));
		socket.onMessage((data) => {
			const frame = JSON.parse(String(data));
			if (frame.t !== "base") return;
			socket.send(JSON.stringify({ t: "hello", peerId: rooms.size }));
			socket.send(
				JSON.stringify({
					t: "base",
					id: frame.id,
					generation: 0,
					revision: 0,
					files: [["document", ""]],
					canonical: { revision: 0, revisionId: null },
				}),
			);
		});
	});
	await context.route(
		"**/api/rpc/osWorkspaces/outputs/patch",
		async (route) => {
			const response = await route.fetch();
			const { json: saved } = await response.json();
			for (const socket of rooms)
				socket.send(
					JSON.stringify({
						t: "output",
						outputId,
						revisionId: saved.revision.id,
						revision: saved.revision.revision,
					}),
				);
			await route.fulfill({ response });
		},
	);
	const peer = await context.newPage();
	const peerCalls: string[] = [];
	peer.on("request", (request) => {
		const name = /\/api\/rpc\/osWorkspaces\/outputs\/(\w+)/.exec(
			request.url(),
		)?.[1];
		if (name) peerCalls.push(name);
	});

	const calls: { name: string; bytes: number; at: number }[] = [];
	page.on("request", (request) => {
		const match = /\/api\/rpc\/osWorkspaces\/outputs\/(\w+)/.exec(
			request.url(),
		);
		if (match)
			calls.push({
				name: match[1]!,
				bytes: request.postData()?.length ?? 0,
				at: Date.now(),
			});
	});
	await page.goto(
		`${server.origin}/workspace/${workspaceId}?workpiece=output%3A${outputId}&pane=workpiece`,
		{ waitUntil: "domcontentloaded" },
	);
	const editor = page
		.frameLocator('iframe[title]:not([title=""])')
		.first()
		.frameLocator("iframe")
		.locator(".tiptap");
	await editor.waitFor({ timeout: 60_000 });
	await peer.goto(page.url(), { waitUntil: "domcontentloaded" });
	const peerEditor = peer
		.frameLocator('iframe[title]:not([title=""])')
		.first()
		.frameLocator("iframe")
		.locator(".tiptap");
	await peerEditor.waitFor({ timeout: 60_000 });
	const peerOpened = peerCalls.length;
	const opened = calls.length;
	await editor.click();
	await page.keyboard.press("ControlOrMeta+End");
	const typedAt = Date.now();
	await page.keyboard.type(" Typed in the browser.");
	const typedFor = Date.now() - typedAt;

	await page.waitForRequest(
		(request) => request.url().includes("/osWorkspaces/outputs/patch"),
		{ timeout: 15_000 },
	);
	await page.waitForTimeout(1_500);
	await peerEditor.getByText(/Typed in the browser\./).waitFor();
	assert.equal(rooms.size, 2, "both tabs joined the workspace room");
	assert(
		peerCalls.slice(peerOpened).includes("changes"),
		"the other tab fetched the save",
	);
	const after = await rpc("osWorkspaces/outputs/get", { outputId });
	assert(
		after.currentRevision.revision > before.currentRevision.revision,
		"typing stored a new revision",
	);
	assert.match(
		JSON.stringify(after.currentRevision.content),
		/Typed in the browser\./,
		"the saved document holds the typed text",
	);
	const since = calls.slice(opened);
	const patches = since.filter((call) => call.name === "patch");
	assert(patches.length >= 1, "the save was a patch");
	assert.equal(
		since.filter((call) => call.name === "revise").length,
		0,
		"the whole document was never sent",
	);
	assert.equal(
		since.filter((call) => call.name === "get").length,
		0,
		"the whole document was not read again after saving",
	);
	const whole = JSON.stringify(after.currentRevision.content).length;
	assert.equal(
		since.filter((call) => call.name === "changes").length,
		0,
		"the saving tab does not fetch its own save",
	);
	for (const patch of patches.slice(1))
		assert(
			patch.bytes < whole,
			`a later save (${patch.bytes} bytes) is smaller than the document (${whole})`,
		);
	// The first save follows the last keystroke within the 1.2 s bound.
	assert(
		patches[0]!.at - typedAt <= typedFor + 1_200 + 800,
		`first save came ${patches[0]!.at - typedAt} ms after typing began`,
	);
	console.log(
		`Doc changed-only save passed: ${patches.length} patch save(s) of ${patches.map((patch) => patch.bytes).join(", ")} bytes for a ${whole}-byte document; first ${patches[0]!.at - typedAt} ms after typing began (${typedFor} ms of typing); calls after open: ${since.map((call) => call.name).join(", ")}`,
	);
	await context.close();
} finally {
	await browser?.close();
	await server.stop();
}
