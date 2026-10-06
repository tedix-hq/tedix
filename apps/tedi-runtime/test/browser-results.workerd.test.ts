import { env } from "cloudflare:workers";
import { abortAllDurableObjects } from "cloudflare:test";
import { createQuickActionTools } from "agents/browser/ai";
import { expect, it } from "vite-plus/test";
import {
	ScopedComputerWorkspace,
	computerWorkspaceScope,
} from "../src/computer-workspace-scope";
import type { TediComputerWorkspaceDO } from "../src/computer-workspace-do";
import {
	browserResultTools,
	retainBrowserResult,
} from "../src/browser-results";

it("retains the SDK's full result in scoped Computer storage and recovers after restart", async () => {
	const binding = (
		env as unknown as {
			TEDI_COMPUTER_WORKSPACE: DurableObjectNamespace<TediComputerWorkspaceDO>;
		}
	).TEDI_COMPUTER_WORKSPACE;
	const sessionKey = crypto.randomUUID();
	const workspace = () =>
		new ScopedComputerWorkspace(
			binding,
			computerWorkspaceScope({ sessionKey }),
			"browser-test",
			async () => "test-tedi",
		).workspace;
	const source = `<rss><channel>${Array.from({ length: 20 }, (_, i) => `<item><title>Post ${i + 1}</title><description>Summary ${i + 1}</description><body>${"large article ".repeat(1500)}</body></item>`).join("")}</channel></rss>`;
	let calls = 0;
	const tools = createQuickActionTools({
		maxChars: 0,
		browser: {
			quickAction: async () => {
				calls++;
				return Response.json({ success: true, result: source });
			},
		},
	});
	const raw = await tools.browser_markdown!.execute!(
		{ url: "https://example.com/rss" } as never,
		{} as never,
	);
	expect(raw).toBe(source);
	const result = await retainBrowserResult(raw, workspace());
	expect(result).toMatchObject({
		totalEntries: 20,
		returnedEntries: 10,
		nextOffset: 10,
	});
	if (!("resultId" in result)) throw new Error("Missing retained result");
	await abortAllDurableObjects();
	const read = browserResultTools(workspace()).browser_read_result!.execute!;
	const second = await read(
		{ resultId: result.resultId, mode: "feed", offset: 10 } as never,
		{} as never,
	);
	expect(second).toMatchObject({ returnedEntries: 10, nextOffset: null });
	expect(calls).toBe(1);
	const other = new ScopedComputerWorkspace(
		binding,
		computerWorkspaceScope({ sessionKey: "other" }),
		"browser-test",
		async () => "test-tedi",
	).workspace;
	await expect(
		browserResultTools(other).browser_read_result!.execute!(
			{ resultId: result.resultId, mode: "text", offset: 0 } as never,
			{} as never,
		),
	).rejects.toThrow();
});
