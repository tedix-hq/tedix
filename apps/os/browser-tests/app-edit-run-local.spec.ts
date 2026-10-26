#!/usr/bin/env bun
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { withBearerToken } from "@tedix/api-client/adapters";
import {
	createLink,
	createORPCClient,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import { LOCAL_DEMO_TOKEN } from "@tedix/auth/local-demo";

// Run against `bun run-local --demo`: actual browser tools, API, and local D1;
// no model call is needed to exercise the Home tool's execution path.
const apiOrigin = `http://localhost:${process.env.TEDIX_LOCAL_API_PORT || "8790"}`;
const osOrigin = `http://localhost:${process.env.TEDIX_LOCAL_OS_PORT || "3030"}`;
const client: RouterContractClient<ApiContract> = createORPCClient(
	createLink({
		url: `${apiOrigin}/rpc`,
		getHeaders: withBearerToken(() => LOCAL_DEMO_TOKEN),
	}),
);
const workspaceId = "00000030-0000-4000-8000-000000000001";
const gadgetId = "00000031-0000-4000-8000-00000000000e";
const conversationId = crypto.randomUUID();
await client.kernelRuntime.enqueueMessage({
	conversationId,
	content: "Inspect the app in this workspace.",
	workspaceContext: {
		workspaceId,
		workpiece: { kind: "gadget", id: gadgetId },
	},
	idempotencyKey: crypto.randomUUID(),
});
const live = await client.osWorkspaces.gadgets.get({ workspaceId, gadgetId });
const before = await client.osWorkspaces.gadgets.getCode({
	workspaceId,
	gadgetId,
});
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage({
		viewport: { width: 1280, height: 800 },
	});
	await page.addInitScript(() => {
		const tools = new Map();
		Object.assign(window, { __appEditTools: tools });
		Object.assign(document, {
			modelContext: {
				registerTool(
					tool: { name: string },
					options?: { signal?: AbortSignal },
				) {
					tools.set(tool.name, tool);
					options?.signal?.addEventListener("abort", () => {
						if (tools.get(tool.name) === tool) tools.delete(tool.name);
					});
				},
			},
		});
	});
	await page.goto(
		`${osOrigin}/workspace/${workspaceId}?workpiece=gadget%3A${gadgetId}&conversation=${encodeURIComponent(conversationId)}&pane=workpiece`,
	);
	await page.waitForFunction(
		() =>
			(
				window as unknown as { __appEditTools: Map<string, unknown> }
			).__appEditTools.has("propose_app_edit"),
		undefined,
		{ timeout: 30000 },
	);
	const result = await page.evaluate(
		async ({ gadgetId }) => {
			const tools = (
				window as unknown as {
					__appEditTools: Map<
						string,
						{
							execute(args: unknown): Promise<unknown>;
						}
					>;
				}
			).__appEditTools;
			const data = (await tools
				.get("read_app_files")!
				.execute({ gadgetId })) as {
				revisionId: string;
				files: Record<string, string>;
			};
			const source = data.files["client.js"]!;
			const proposed = await tools.get("propose_app_edit")!.execute({
				gadgetId,
				expectedRevisionId: data.revisionId,
				edits: [
					{
						path: "client.js",
						before: source,
						after: `${source}\n// Local draft proof\n`,
					},
				],
			});
			return { read: data, proposed };
		},
		{ gadgetId },
	);
	const proposals = await client.osWorkspaces.collaboration.list({
		workspaceId,
		documentType: "gadget",
		documentId: gadgetId,
		statuses: ["open"],
		limit: 100,
	});
	const proposal = proposals.items.find(
		(row) => row.sourceKind === "chat" && row.sourceId === conversationId,
	);
	assert(proposal, "Home tool saved a chat proposal in real local D1");
	assert.equal(proposal.baseRevisionId, live.currentRevision!.id);
	assert.equal(
		(await client.osWorkspaces.gadgets.get({ workspaceId, gadgetId }))
			.currentRevision!.id,
		live.currentRevision!.id,
	);
	assert.deepEqual(
		await client.osWorkspaces.gadgets.getCode({ workspaceId, gadgetId }),
		before,
	);
	await page.getByRole("button", { name: /^Drafts/ }).click();
	await page.locator(`[data-app-draft="${proposal.id}"]`).waitFor();
	console.log(
		JSON.stringify({
			proof: "run-local workspace Home app-edit tools",
			proposalId: proposal.id,
			conversationId,
			baseRevisionId: proposal.baseRevisionId,
			mainlineUnchanged: true,
			draftVisible: true,
			modelCalls: 0,
			toolResult: result.proposed,
		}),
	);
} finally {
	await browser?.close();
}
