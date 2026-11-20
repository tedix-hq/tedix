import { demoPackWorkspaceFiles } from "./local-demo-pack-seed";

type Row = Record<string, string | number | null>;
const ORG = "00000000-0000-4000-8000-000000000001";
const REVENUE_OPS = "00000000-0000-4000-8000-000000000007";
const owner = { created_by_kind: "user", created_by_id: "local-demo-owner" };

/** Every seeded workspace with the files and resources its own store starts with. */
export function localWorkspaceFiles(nowMs: number = Date.now()) {
	const seeded = "2026-08-10T00:00:00.000Z";
	return [
		{
			workspaceId: REVENUE_OPS,
			tables: {
				os_outputs: [
					{
						id: "00000000-0000-4000-8000-000000000008",
						organization_id: ORG,
						workspace_id: REVENUE_OPS,
						kind: "document",
						title: "Local Shared Draft",
						status: "active",
						current_revision_id: "00000000-0000-4000-8000-000000000009",
						...owner,
						created_at: seeded,
						updated_at: seeded,
					},
				],
				os_output_revisions: [
					{
						id: "00000000-0000-4000-8000-000000000009",
						organization_id: ORG,
						output_id: "00000000-0000-4000-8000-000000000008",
						revision: 1,
						content: JSON.stringify({
							kind: "document",
							blocks: [{ type: "paragraph", text: "Shared local draft" }],
						}),
						access_envelope: JSON.stringify({ version: 1, sources: [] }),
						note: "Credential-free collaboration seed",
						...owner,
						created_at: seeded,
					},
				],
			} as Record<string, Row[]>,
		},
		...demoPackWorkspaceFiles(nowMs),
	];
}

if (import.meta.main) {
	const port = process.env.TEDIX_LOCAL_WORKSPACE_PORT;
	const token = process.env.TEDIX_LOCAL_WORKSPACE_SEED_TOKEN;
	if (!port || !token || process.env.TEDIX_LOCAL_RUN_MODE !== "demo")
		throw new Error("Workspace seeding requires the local demo launcher");
	// A store seeds once; a restart keeps edits made in the demo.
	for (const { workspaceId, tables } of localWorkspaceFiles()) {
		const response = await fetch(
			`http://localhost:${port}/local-demo/workspaces/${ORG}/${workspaceId}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(tables),
			},
		);
		if (!response.ok)
			throw new Error(
				`Seeding workspace ${workspaceId} failed: ${response.status} ${await response.text()}`,
			);
	}
}
