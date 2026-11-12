import assert from "node:assert/strict";
import {
	chromium,
	type Browser,
	type BrowserContext,
	type Page,
	type WebSocketRoute,
} from "playwright";
import { buildDocBlueprint } from "@tedix/api-contract/assets/doc-blueprint";
import { startFixtureServer } from "./fixture-server";

const workspaceId = "00000030-0000-4000-8000-000000000001";
const outputId = "00000040-0000-4000-8000-000000000001";

/**
 * The real Doc editor open on one file of the fixture workspace, in a real
 * browser and the real sandbox. `open()` gives another tab on the same file;
 * a save in one tab reaches the others the way the workspace room delivers
 * it. Saves write fixture state, so each spec owns its server.
 */
export async function startDocTabs(
	options: { reducedMotion?: "reduce" | "no-preference" } = {},
) {
	const server = await startFixtureServer("/", { shared: false });
	let browser: Browser | undefined, context: BrowserContext;
	try {
		browser = await chromium.launch({ headless: true });
		context = await browser.newContext({
			viewport: { width: 1280, height: 800 },
			reducedMotion: options.reducedMotion ?? "reduce",
		});
	} catch (error) {
		await browser?.close();
		await server.stop();
		throw error;
	}
	const rpc = async (method: string, input: unknown) => {
		const response = await context.request.post(
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
	const doc = buildDocBlueprint(
		installed.currentRevision.manifest.config.settings.slot,
	).gadgets![0]!;
	await rpc("osWorkspaces/gadgets/revise", {
		workspaceId,
		gadgetId: gadget.id,
		manifest: doc.manifest,
		files: doc.files,
	});
	// The fixture API has no live room. Deliver each real save's notice to
	// every tab over the same WebSocket frames as the production room.
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
	const announce = (revision: { id: string; revision: number }) => {
		for (const socket of rooms)
			socket.send(
				JSON.stringify({
					t: "output",
					outputId,
					revisionId: revision.id,
					revision: revision.revision,
				}),
			);
	};
	await context.route(
		"**/api/rpc/osWorkspaces/outputs/patch",
		async (route) => {
			const response = await route.fetch();
			if (response.ok()) announce((await response.json()).json.revision);
			await route.fulfill({ response });
		},
	);
	return {
		rpc,
		/** The saved file as the server holds it now. */
		saved: async () =>
			(await rpc("osWorkspaces/outputs/get", { outputId })).currentRevision as {
				id: string;
				revision: number;
				content: { richText: { content: unknown[] } };
			},
		/**
		 * Save a change the way an agent does: straight to the server, then
		 * announced to the open tabs.
		 */
		async writeAsAgent(patch: unknown) {
			const current = (await rpc("osWorkspaces/outputs/get", { outputId }))
				.currentRevision;
			const result = await rpc("osWorkspaces/outputs/patch", {
				outputId,
				baseRevision: current.revision,
				patch,
			});
			announce(result.revision);
			return result;
		},
		/** Another tab on the file, with its editor ready. */
		async open(): Promise<{
			page: Page;
			frame: ReturnType<Page["frameLocator"]>;
			editor: ReturnType<Page["locator"]>;
		}> {
			const page = await context.newPage();
			page.setDefaultNavigationTimeout(120_000);
			await page.goto(
				`${server.origin}/workspace/${workspaceId}?workpiece=output%3A${outputId}&pane=workpiece`,
				{ waitUntil: "domcontentloaded" },
			);
			const frame = page
				.frameLocator('iframe[title]:not([title=""])')
				.first()
				.frameLocator("iframe");
			const editor = frame.locator(".tiptap");
			await editor.waitFor({ timeout: 60_000 });
			return { page, frame, editor };
		},
		async stop() {
			await context.close().catch(() => undefined);
			await browser?.close();
			await server.stop();
		},
	};
}
