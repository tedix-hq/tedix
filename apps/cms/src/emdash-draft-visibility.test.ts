import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDialect } from "emdash/db/sqlite";
import { POST as mcpPost } from "../templates/tedix/node_modules/emdash/dist/astro/routes/api/mcp.mjs";
import { GET as restListGet } from "../templates/tedix/node_modules/emdash/dist/astro/routes/api/content/_collection_/index.mjs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [
			{
				slug: "pages",
				label: "Pages",
				supports: ["drafts", "revisions"],
				fields: [{ slug: "title", label: "Title", type: "string" }],
			},
		],
	},
	userSeed: null,
}));

// Exercise the compiled runtime shipped in both tenant starters.
// @ts-expect-error Emdash does not publish declarations for its internal chunk.
import { n as TedixEmDashRuntime } from "../templates/tedix/node_modules/emdash/dist/emdash-runtime-BlybX9Ui.mjs";
describe("Emdash draft visibility", () => {
	const EmDashRuntime = TedixEmDashRuntime;
	type Runtime = InstanceType<typeof TedixEmDashRuntime>;
	const runtimes: Runtime[] = [];
	let testDir: string | undefined;

	afterEach(async () => {
		for (const runtime of runtimes) {
			await runtime.stopCron();
			await runtime.db.destroy();
		}
		runtimes.length = 0;
		if (testDir) await rm(testDir, { recursive: true, force: true });
		testDir = undefined;
	});

	it("keeps published values live-only while editors read staged revisions across a list page", async () => {
		testDir = await mkdtemp(join(tmpdir(), "tedix-emdash-draft-visibility-"));
		const url = `file:${join(testDir, "site.db")}`;
		const runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: "draft-visibility",
					config: { url },
					type: "sqlite",
				},
			},
			plugins: [],
			createDialect: () => createDialect({ url }),
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
		runtimes.push(runtime);

		const ids: string[] = [];
		for (const title of ["First live", "Second live"]) {
			const created = await runtime.handleContentCreate("pages", {
				data: { title },
				status: "published",
			});
			expect(created.success).toBe(true);
			if (!created.success) throw new Error(created.error.message);
			ids.push(created.data.item.id);
		}
		for (const [index, id] of ids.entries()) {
			const updated = await runtime.handleContentUpdate("pages", id, {
				data: { title: `Private draft ${index + 1}` },
			});
			expect(updated.success).toBe(true);
		}

		const editorList = await runtime.handleContentList("pages", {
			status: "published",
			includeDrafts: true,
		});
		expect(editorList.success).toBe(true);
		if (!editorList.success) throw new Error(editorList.error.message);
		expect(editorList.data.items).toHaveLength(2);
		const byTitle = editorList.data.items.sort(
			(a: { data: { title: string } }, b: { data: { title: string } }) =>
				String(a.data.title).localeCompare(String(b.data.title)),
		);
		for (const [index, item] of byTitle.entries()) {
			expect(item.data.title).toBe(`Private draft ${index + 1}`);
			expect(item.liveData?.title).toBe(
				index === 0 ? "First live" : "Second live",
			);
			expect(item.draftRevisionId).toBeTruthy();
		}

		const subscriberList = await runtime.handleContentList("pages", {
			status: "published",
			includeDrafts: false,
		});
		expect(subscriberList.success).toBe(true);
		if (!subscriberList.success) throw new Error(subscriberList.error.message);
		expect(
			subscriberList.data.items
				.map((item: { data: { title: string } }) => item.data.title)
				.sort(),
		).toEqual(["First live", "Second live"]);
		for (const item of subscriberList.data.items) {
			expect(item.draftRevisionId).toBeNull();
			expect(item.liveData).toBeUndefined();
		}

		const editorGet = await runtime.handleContentGet(
			"pages",
			ids[0],
			undefined,
			{ includeDrafts: true },
		);
		expect(editorGet.success && editorGet.data.item.data.title).toBe(
			"Private draft 1",
		);
		const subscriberGet = await runtime.handleContentGet(
			"pages",
			ids[0],
			undefined,
			{ includeDrafts: false },
		);
		expect(subscriberGet.success && subscriberGet.data.item.data.title).toBe(
			"First live",
		);
		if (!subscriberGet.success) throw new Error(subscriberGet.error.message);
		expect(subscriberGet.data.item.draftRevisionId).toBeNull();
		expect(subscriberGet.data.item.liveData).toBeUndefined();

		const draftOnly = await runtime.handleContentCreate("pages", {
			data: { title: "Unpublished only" },
			status: "draft",
		});
		expect(draftOnly.success).toBe(true);
		if (!draftOnly.success) throw new Error(draftOnly.error.message);

		const callMcp = async (
			role: number,
			name: string,
			args: Record<string, unknown>,
		) => {
			const request = new Request("http://localhost/_emdash/api/mcp", {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const response = await mcpPost({
				request,
				locals: { emdash: runtime, user: { id: "test-user", role } },
			} as unknown as Parameters<typeof mcpPost>[0]);
			expect(response.status).toBe(200);
			const body = await response.text();
			const event =
				body
					.split("\n")
					.find((line) => line.startsWith("data: "))
					?.slice(6) ?? body;
			const payload = JSON.parse(event);
			return payload.result as {
				content: Array<{ type: string; text: string }>;
				isError?: boolean;
			};
		};
		const subscriberResult = await callMcp(10, "content_get", {
			collection: "pages",
			id: ids[0],
		});
		expect(
			JSON.parse(subscriberResult.content.at(0)?.text ?? "{}").item.data.title,
		).toBe("First live");
		const editorResult = await callMcp(40, "content_get", {
			collection: "pages",
			id: ids[0],
		});
		expect(
			JSON.parse(editorResult.content.at(0)?.text ?? "{}").item.data.title,
		).toBe("Private draft 1");
		const hidden = await callMcp(10, "content_get", {
			collection: "pages",
			id: draftOnly.data.item.id,
		});
		expect(hidden.isError).toBe(true);
		expect(hidden.content.at(0)?.text ?? "{}").toContain("[NOT_FOUND]");
		const subscriberPage = await callMcp(10, "content_list", {
			collection: "pages",
			status: "draft",
		});
		const subscriberItems = JSON.parse(
			subscriberPage.content.at(0)?.text ?? "{}",
		).items;
		expect(subscriberItems).toHaveLength(2);
		expect(
			subscriberItems
				.map((item: { data: { title: string } }) => item.data.title)
				.sort(),
		).toEqual(["First live", "Second live"]);
		const editorPage = await callMcp(40, "content_list", {
			collection: "pages",
			status: "published",
		});
		expect(
			JSON.parse(editorPage.content.at(0)?.text ?? "{}").items[0].liveData,
		).toBeTruthy();
		const listRest = async (role: number, status: string) => {
			const url = new URL("http://localhost/_emdash/api/content/pages");
			url.searchParams.set("status", status);
			const response = await restListGet({
				params: { collection: "pages" },
				url,
				locals: { emdash: runtime, user: { id: "test-user", role } },
			} as unknown as Parameters<typeof restListGet>[0]);
			expect(response.status).toBe(200);
			return (await response.json()) as {
				success: boolean;
				data: {
					items: Array<{
						id: string;
						data: { title: string };
						status: string;
						draftRevisionId: string | null;
						liveData?: { title: string };
					}>;
				};
			};
		};
		const restEditor = await listRest(40, "published");
		expect(restEditor.success).toBe(true);
		expect(restEditor.data.items).toHaveLength(2);
		expect(restEditor.data.items.map((item) => item.data.title).sort()).toEqual(
			["Private draft 1", "Private draft 2"],
		);
		for (const item of restEditor.data.items) {
			expect(item.liveData?.title).toMatch(/live$/);
			expect(item.draftRevisionId).toBeTruthy();
		}
		const restSubscriber = await listRest(10, "draft");
		expect(restSubscriber.data.items).toHaveLength(2);
		expect(
			restSubscriber.data.items.map((item) => item.data.title).sort(),
		).toEqual(["First live", "Second live"]);
		for (const item of restSubscriber.data.items) {
			expect(item.status).toBe("published");
			expect(item.draftRevisionId).toBeNull();
			expect(item.liveData).toBeUndefined();
		}
		const restDrafts = await listRest(40, "draft");
		expect(restDrafts.data.items.map((item) => item.id)).toEqual([
			draftOnly.data.item.id,
		]);
	});
});
