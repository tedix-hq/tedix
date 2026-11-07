#!/usr/bin/env bun
/**
 * Prove the workspace change feed end to end against a running `bun run-local`.
 *
 * 1. Creates a workspace and an output through the authenticated local API.
 * 2. Measures how long until the output shows up in the output library
 *    (search) and in the recent-activity projection; both must be under 1 s.
 * 3. Opens the local D1 file and runs the reconciler: the core ledger and the
 *    projection must report zero drift for that workspace.
 *
 * Usage: TEDIX_LOCAL_API_PORT=8795 bun scripts/workspace-feed-local-check.ts
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { withBearerToken } from "@tedix/api-client/adapters";
import { createLink, createORPCClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import type { RouterContractClient } from "@tedix/api-contract/types";
import { createDbQueryClient } from "../packages/db/src/query-client";
import { snapshotWorkspaceFeedLedger } from "../packages/db/src/queries/workspace-feed/ledger";
import { createD1Facade } from "../packages/db/src/test/d1-facade";
import { reconcileWorkspaceFeed } from "../packages/workspace-feed/src/reconcile";
import { LOCAL_DEMO_TOKEN } from "../packages/auth/src/local-demo";

const apiOrigin = `http://localhost:${process.env.TEDIX_LOCAL_API_PORT || "8790"}`;
const stateDir = process.env.TEDIX_LOCAL_STATE_DIR || ".wrangler/run-local";
const budgetMs = 1_000;

function fail(message: string): never {
	console.error(`FAIL ${message}`);
	process.exit(1);
}

const bootstrap: RouterContractClient<ApiContract> = createORPCClient(
	createLink({
		url: `${apiOrigin}/rpc`,
		getHeaders: withBearerToken(() => LOCAL_DEMO_TOKEN),
	}),
);
const launchable = await bootstrap.organizations.listOsMine({
	limit: 50,
	offset: 0,
});
let { organization } = await bootstrap.organizations.getMyOrganization({});
if (launchable.data.length === 0) {
	organization = await bootstrap.organizations.completeOsOnboarding({
		organizationId: organization.id,
		name: "My Local OS",
		slug: "my-local-os",
	});
}
const organizationId = organization.id;
const client: RouterContractClient<ApiContract> = createORPCClient(
	createLink({
		url: `${apiOrigin}/rpc`,
		getHeaders: async () => ({
			Authorization: `Bearer ${LOCAL_DEMO_TOKEN}`,
			"X-Tedix-Org-Id": organizationId,
		}),
	}),
);

const marker = `feed-check-${Date.now().toString(36)}`;
const { workspace } = await client.osWorkspaces.workspaces.create({
	name: `Feed check ${marker}`,
	description: "Workspace change feed local proof",
});
const started = performance.now();
const { output } = await client.osWorkspaces.outputs.create({
	kind: "document",
	title: `Quarterly plan ${marker}`,
	workspaceId: workspace.id,
	content: {
		kind: "document",
		blocks: [
			{ type: "paragraph", text: `Revenue targets ${marker} for the quarter.` },
		],
	},
});

async function waitFor(
	label: string,
	probe: () => Promise<boolean>,
): Promise<number> {
	for (;;) {
		if (await probe()) return performance.now() - started;
		if (performance.now() - started > 10_000)
			fail(`${label} did not show the output within 10 s`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const libraryMs = await waitFor("output library search", async () => {
	const page = await client.osWorkspaces.outputs.library({
		search: marker,
		limit: 20,
	});
	return page.items.some((item) => item.output.id === output.id);
});
const activityMs = await waitFor("recent activity", async () => {
	const page = await client.osWorkspaces.workspaces.activity({
		workspaceId: workspace.id,
		limit: 20,
	});
	return page.items.some(
		(item) => item.kind === "output" && item.entityId === output.id,
	);
});

// A second revision and a rename exercise the current-revision switch.
await client.osWorkspaces.outputs.revise({
	outputId: output.id,
	expectedRevision: 1,
	content: {
		kind: "document",
		blocks: [{ type: "paragraph", text: `Revised targets ${marker}.` }],
	},
});
await client.osWorkspaces.outputs.rename({
	outputId: output.id,
	title: `Quarterly plan ${marker} (final)`,
});
const library = await client.osWorkspaces.outputs.library({
	search: "revised targets",
	limit: 20,
});
const card = library.items.find((item) => item.output.id === output.id);
if (!card || card.currentRevision.revision !== 2)
	fail("library does not show revision 2 after revise");
if (!card.output.title.endsWith("(final)"))
	fail("library does not show the renamed title");

const d1Dir = join(stateDir, "v3/d1/miniflare-D1DatabaseObject");
const file = readdirSync(d1Dir).find(
	(name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
);
if (!file) fail(`no local D1 file under ${d1Dir}`);
const db = createDbQueryClient(
	createD1Facade(new DatabaseSync(join(d1Dir, file), { readOnly: true })),
);
const report = await reconcileWorkspaceFeed(
	db,
	await snapshotWorkspaceFeedLedger(db, workspace.id),
);

const result = {
	workspaceId: workspace.id,
	outputId: output.id,
	libraryVisibleMs: Math.round(libraryMs),
	activityVisibleMs: Math.round(activityMs),
	ledgerLastSeq: report.object.lastSeq,
	projectionLastSeq: report.projection.lastSeq,
	drift: report.drift,
};
console.log(JSON.stringify(result, null, 2));
if (libraryMs > budgetMs || activityMs > budgetMs)
	fail(`projection latency above ${budgetMs} ms`);
if (report.drift.length > 0) fail("reconciler reports drift");
if (report.object.lastSeq !== 3) fail("expected three ledger events");
console.log("PASS workspace feed: library + activity < 1 s, zero drift");
