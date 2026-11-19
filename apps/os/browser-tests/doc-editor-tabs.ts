import assert from "node:assert/strict";
import {
	chromium,
	type Browser,
	type Page,
	type WebSocketRoute,
} from "playwright";
import { buildDocBlueprint } from "@tedix/api-contract/assets/doc-blueprint";
import { buildSheetBlueprint } from "@tedix/api-contract/assets/sheet-blueprint";
import { buildSlidesBlueprint } from "@tedix/api-contract/assets/slides-blueprint";
import { startFixtureServer } from "./fixture-server";

const seedDocumentId = "00000040-0000-4000-8000-000000000001";
const blueprints = {
	document: buildDocBlueprint,
	sheet: buildSheetBlueprint,
	presentation: buildSlidesBlueprint,
};

/** The Doc editor on a copy of the fixture document. */
export const startDocTabs = (
	options: { reducedMotion?: "reduce" | "no-preference" } = {},
) => startEditorTabs({ ...options, kind: "document" });

/**
 * Opens a real Doc, Sheet or Slides editor on a fresh file in a private
 * workspace so specs can share a fixture server. `open()` gives another
 * tab on that file. Saves reach the other tabs through workspace room
 * messages.
 */
export async function startEditorTabs(options: {
	kind: keyof typeof blueprints;
	/** The initial content, defaulting to a copy of the fixture document. */
	content?: unknown;
	/** What marks the editor as ready inside its frame. */
	ready?: string;
	readyState?: "attached" | "visible";
	reducedMotion?: "reduce" | "no-preference";
	/** A phone: its size, with touch and the mobile viewport. */
	phone?: { width: number; height: number };
}) {
	const server = await startFixtureServer();
	let browser: Browser | undefined;
	async function stop() {
		try {
			await browser?.close();
		} finally {
			await server.stop();
		}
	}
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext({
			viewport: options.phone ?? { width: 1280, height: 800 },
			...(options.phone ? { isMobile: true, hasTouch: true } : {}),
			reducedMotion: options.reducedMotion ?? "reduce",
		});
		const rpc = async (method: string, input: unknown) => {
			const response = await context.request.post(
				`${server.origin}/api/rpc/${method}`,
				{ data: { json: input } },
			);
			assert(response.ok(), `${method}: ${await response.text()}`);
			return (await response.json()).json;
		};
		const { kind } = options;
		const { workspace } = await rpc("osWorkspaces/workspaces/create", {
			name: "Editor browser test",
			visibility: "private",
		});
		const workspaceId: string = workspace.id;
		const seed =
			options.content === undefined
				? await rpc("osWorkspaces/outputs/get", { outputId: seedDocumentId })
				: undefined;
		const { output } = await rpc("osWorkspaces/outputs/create", {
			workspaceId,
			kind,
			title: seed?.output.title ?? "Browser test file",
			content: seed ? seed.currentRevision.content : options.content,
		});
		const outputId: string = output.id;
		const { gadget } = await rpc("osWorkspaces/gadgets/installOutputEditor", {
			workspaceId,
			outputId,
			kind,
		});
		// The local lane installs a placeholder editor. Give the app the real
		// editor, exactly as an organization's workspace runs it.
		const installed = await rpc("osWorkspaces/gadgets/get", {
			workspaceId,
			gadgetId: gadget.id,
		});
		const doc = blueprints[kind](
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
		const saved = async () =>
			(await rpc("osWorkspaces/outputs/get", { outputId })).currentRevision as {
				id: string;
				revision: number;
				// oxlint-disable-next-line typescript/no-explicit-any
				content: any;
			};
		return {
			outputId,
			async waitForSave(page: Page, matches: (content: unknown) => boolean) {
				await page.waitForResponse(
					async (response) =>
						response.url().endsWith("/api/rpc/osWorkspaces/outputs/patch") &&
						response.ok() &&
						matches((await saved()).content),
				);
			},
			/** The saved file as the server holds it now. */
			saved,
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
			async open(observePage?: (page: Page) => void): Promise<{
				page: Page;
				frame: ReturnType<Page["frameLocator"]>;
				editor: ReturnType<Page["locator"]>;
			}> {
				const page = await context.newPage();
				observePage?.(page);
				page.setDefaultNavigationTimeout(120_000);
				await page.goto(
					`${server.origin}/workspace/${workspaceId}?workpiece=output%3A${outputId}&pane=workpiece`,
					{ waitUntil: "domcontentloaded" },
				);
				const frame = page
					.frameLocator('iframe[title]:not([title=""])')
					.first()
					.frameLocator("iframe");
				const editor = frame.locator(options.ready ?? ".tiptap");
				await editor
					.first()
					.waitFor({ timeout: 60_000, state: options.readyState ?? "visible" });
				return { page, frame, editor };
			},
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
