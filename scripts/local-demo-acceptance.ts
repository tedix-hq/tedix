#!/usr/bin/env bun

import { withBearerToken } from "@tedix/api-client/adapters";
import {
	createLink,
	createORPCClient,
	getApiClient,
} from "@tedix/api-client/client";
import { demoTodayId } from "../apps/os/dev/demo-pack";
import { readToday } from "../apps/os/src/lib/today-digest";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import type { RouterContractClient } from "@tedix/api-contract/types";
import {
	LOCAL_DEMO_ORGANIZATION_SLUG,
	LOCAL_DEMO_TEDI_ID,
	LOCAL_DEMO_TOKEN,
} from "../packages/auth/src/local-demo";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const restartMarker = process.env.TEDIX_LOCAL_RESTART_MARKER?.trim() ?? "";
const restartPhase = process.env.TEDIX_LOCAL_RESTART_PHASE?.trim() ?? "";
const runMode = process.env.TEDIX_LOCAL_RUN_MODE?.trim() || "start";
assert(
	runMode === "start" || runMode === "demo",
	"TEDIX_LOCAL_RUN_MODE must be start or demo",
);
const demo = runMode === "demo";
assert(
	(restartMarker === "" && restartPhase === "") ||
		(restartMarker !== "" &&
			(restartPhase === "write" || restartPhase === "read")),
	"Restart acceptance requires both TEDIX_LOCAL_RESTART_MARKER and a write/read TEDIX_LOCAL_RESTART_PHASE",
);

const apiOrigin = `http://localhost:${process.env.TEDIX_LOCAL_API_PORT || "8790"}`;
const osOrigin = `http://localhost:${process.env.TEDIX_LOCAL_OS_PORT || "3030"}`;
const health = await fetch(`${apiOrigin}/health`);
assert(health.ok, `API health returned ${health.status}`);

const osResponse = await fetch(osOrigin);
assert(osResponse.ok, `Tedix OS returned ${osResponse.status}`);
const osHtml = await osResponse.text();
assert(
	osHtml.includes("<title>Tedix OS</title>"),
	"Tedix OS HTML did not contain the product shell title",
);

const link = createLink({
	url: `${apiOrigin}/rpc`,
	getHeaders: withBearerToken(() => LOCAL_DEMO_TOKEN),
});
const client: RouterContractClient<ApiContract> = createORPCClient(link);
const osClient = getApiClient<ApiContract>(`${osOrigin}/api`);

const launchableBefore = await client.organizations.listOsMine({
	limit: 50,
	offset: 0,
});
if (!demo && restartPhase !== "read") {
	assert(
		launchableBefore.data.length === 0,
		"Blank-start acceptance found an already provisioned local OS",
	);
}

const bootstrap = await client.organizations.getMyOrganization({});
let organization = bootstrap.organization;
let onboarding = "already complete";
if (!demo && launchableBefore.data.length === 0) {
	organization = await client.organizations.completeOsOnboarding({
		organizationId: organization.id,
		name: "My Local OS",
		slug: "my-local-os",
	});
	onboarding = "canonical organization bootstrap and OS onboarding completed";
}
if (demo) {
	assert(
		organization.slug === LOCAL_DEMO_ORGANIZATION_SLUG,
		"Local organization slug did not match the deterministic demo seed",
	);
} else {
	const launchableAfter = await client.organizations.listOsMine({
		limit: 50,
		offset: 0,
	});
	assert(
		launchableAfter.data.some(
			(item) => item.organizationId === organization.id,
		),
		"Completed local onboarding did not make the organization launchable",
	);
}

const tedis = await client.tedis.list({ limit: 20, offset: 0 });
assert(
	demo
		? tedis.data.some((tedi) => tedi.id === LOCAL_DEMO_TEDI_ID)
		: tedis.data.length > 0,
	demo
		? "Seeded local tedi was not visible through the authenticated API"
		: "First-run organization bootstrap did not create a local tedi",
);

const workspaces = await osClient.osWorkspaces.workspaces.list({
	status: "active",
	limit: 50,
});
if (demo) {
	assert(
		workspaces.items.some((workspace) => workspace.name === "Revenue Ops"),
		"Tedix OS did not expose the D1-backed Revenue Ops Workspace",
	);
	const revenueOps = workspaces.items.find(
		(workspace) => workspace.name === "Revenue Ops",
	);
	assert(
		revenueOps,
		"The deterministic Revenue Ops Workspace was not returned",
	);
	const sharedOutputs = await osClient.osWorkspaces.outputs.list({
		workspaceId: revenueOps.id,
		limit: 50,
	});
	assert(
		sharedOutputs.items.some((output) => output.title === "Local Shared Draft"),
		"The collaboration-ready local output was not available through the OS Worker",
	);
	const deck = await osClient.attention.listDeckCards({ limit: 100 });
	assert(
		deck.complete && deck.count > 0,
		"Sample Decisions is empty or incomplete",
	);
	const activity = await osClient.workItems.listActivity({ limit: 50 });
	assert(
		activity.events.length === 6 &&
			activity.events.every(
				(event) =>
					event.workItemTitle.startsWith("Reddit Scout") ||
					event.workItemTitle.startsWith("Reconciler") ||
					event.workItemTitle.startsWith("On-call"),
			),
		"Sample Activity is missing or contains classic fixtures",
	);
	const today = await osClient.osWorkspaces.outputs.get({
		outputId: demoTodayId,
	});
	assert(
		readToday(today.currentRevision.content)?.rows.length === 3,
		"Sample Today digest is unavailable",
	);
	const blocked = await fetch(
		`${osOrigin}/api/rpc/workInteractions/outbound/act`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				json: {
					action: "approve_send",
					workItemId: activity.events[0]!.workItemId,
					expectedVersion: 1,
				},
			}),
		},
	);
	assert(
		blocked.status === 403 &&
			(await blocked.text()).includes("Sending is switched off"),
		"Demo send was not blocked",
	);
} else if (restartPhase !== "read") {
	// Onboarding installs the tenant-owned Feed/Deck blueprint, without demo data.
	const work = workspaces.items[0];
	assert(
		workspaces.items.length === 1 &&
			work?.name === "Work" &&
			work.sourceBlueprintRevisionNumber === 1 &&
			work.sourceBlueprintId !== null &&
			work.sourceBlueprintRevisionId !== null,
		"Blank-start onboarding must contain only the pinned default Work workspace",
	);
	const defaults = await osClient.osWorkspaces.gadgets.workApps({ limit: 50 });
	assert(
		!defaults.truncated &&
			defaults.items.length === 2 &&
			defaults.items.every((item) => item.gadget.workspaceId === work.id) &&
			["feed", "deck"].every((role) =>
				defaults.items.some(
					(item) => item.currentRevision.manifest.navigation?.work === role,
				),
			),
		"Blank-start onboarding must install exactly the default Activity and Decisions apps",
	);
}

const proofName = "Local API Persistence";
const existingProof = workspaces.items.find(
	(workspace) => workspace.name === proofName,
);
const proofWorkspace = existingProof
	? existingProof
	: (
			await osClient.osWorkspaces.workspaces.create({
				name: proofName,
				description: "Created through the same-origin local OS API boundary.",
			})
		).workspace;
const proofDescription = restartMarker
	? `Restart certification marker ${restartMarker}`
	: "Written through Tedix OS and committed by the isolated API to D1.";
if (restartPhase !== "read") {
	await osClient.osWorkspaces.workspaces.update({
		workspaceId: proofWorkspace.id,
		description: proofDescription,
	});
	await osClient.osWorkspaces.workspacePreferences.setFavorite({
		workspaceId: proofWorkspace.id,
		favorite: true,
	});
}

const directWorkspace = await client.osWorkspaces.workspaces.get({
	workspaceId: proofWorkspace.id,
});
assert(
	directWorkspace.workspace.description === proofDescription,
	"Direct API readback did not observe the Workspace mutation made through Tedix OS",
);
const directPreferences = await client.osWorkspaces.workspacePreferences.list(
	{},
);
assert(
	directPreferences.items.some(
		(preference) =>
			preference.workspaceId === proofWorkspace.id && preference.favorite,
	),
	"Direct API readback did not observe the OS favorite written to D1",
);
const osPreferences = await osClient.userSettings.getPreferences({});
assert(
	osPreferences.preferences.theme === "system",
	"The local user identity did not resolve its canonical OS preference record",
);

let inference = "disabled";
if (process.env.TEDIX_LOCAL_INFERENCE_ENABLED === "true") {
	const backend =
		process.env.TEDIX_LOCAL_INFERENCE_BACKEND?.trim() || "gateway";
	assert(
		backend === "gateway" || backend === "workers-ai",
		"TEDIX_LOCAL_INFERENCE_BACKEND must be gateway or workers-ai",
	);
	const backendLabel =
		backend === "gateway" ? "Tedix AI Gateway" : "Workers AI";
	const marker = `TEDIX_LOCAL_INFERENCE_${crypto.randomUUID()}`;
	const enqueue = await osClient.kernelRuntime.enqueueMessage({
		conversationId: "home:main",
		content: `Answer this simple question directly in Home without tools or delegation: what is 2 + 2? Include this marker verbatim in the answer: ${marker}`,
		idempotencyKey: crypto.randomUUID(),
	});
	assert(
		enqueue.status === "queued" || enqueue.status === "needs_delegation",
		`Local inference enqueue returned ${enqueue.status}: ${enqueue.error ?? "no detail"}`,
	);

	let offset = 0;
	let closed = false;
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline && !closed) {
		const events = await osClient.kernelRuntime.readRunEvents({
			runId: enqueue.run.id,
			offset,
			waitMs: 10_000,
		});
		offset = events.stream.nextOffset;
		closed = events.stream.closed;
	}
	assert(
		closed,
		"The opt-in local inference run did not reach a terminal state",
	);
	const transcript = await osClient.kernelRuntime.readMessages({
		conversationId: enqueue.conversationId,
		limit: 100,
	});
	const echoed = transcript.messages.some(
		(message) =>
			message.role === "assistant" &&
			typeof message.content === "string" &&
			message.content.includes(marker),
	);
	assert(
		echoed,
		`The ${backendLabel} response did not echo the unique proof marker`,
	);
	inference = `${backendLabel} response echoed ${marker}`;
}

console.log(
	JSON.stringify(
		{
			status: "passed",
			os: osOrigin,
			mode: runMode,
			organization: organization.slug,
			onboarding,
			tedi: demo
				? tedis.data.find((tedi) => tedi.id === LOCAL_DEMO_TEDI_ID)?.slug
				: tedis.data[0]?.slug,
			workspace: directWorkspace.workspace.name,
			persistence: "OS proxy write -> API/D1 -> direct API readback",
			collaborationSeed: demo ? "Local Shared Draft" : "not seeded",
			inference,
			restart:
				restartMarker === ""
					? "not requested"
					: {
							phase: restartPhase,
							marker: restartMarker,
							persistence:
								"unique first-boot D1 marker and favorite observed through second-boot API readback",
						},
		},
		null,
		2,
	),
);
