import { DatabaseSync } from "node:sqlite";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	confirmOsWorkspaceFile,
	instantiateOsBlueprint,
} from "./os-workspace-outputs";
import { hydrateOutputRevision } from "./os-output-revision-body-store";
import { resolveWorkEvidenceReference } from "./work-evidence-resolution";
import type { BaseContext } from "../rpc/orpc";

import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import { getOsOutputRevision as readObjectRevision } from "@tedix/db/queries/durable-sqlite/os-outputs";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
	);
	sqlite.exec(
		schemaDdl(osWorkspaces, osOutputs, osOutputRevisions, osWorkspaceResources),
	);
	const object = workspaceOutputFixture(sqlite);
	onTestFinished(() => sqlite.close());
	// Evidence resolution reads through the default Worker binding, so the
	// writers under test share the stubbed `cloudflare:workers` bucket.
	const bucket = {
		put: vi.fn((key: string, bytes: ArrayBuffer) =>
			env.R2_BUCKET.put(key, bytes),
		),
		get: vi.fn((key: string) => env.R2_BUCKET.get(key)),
	};
	return {
		...object,
		sqlite,
		db: createDbQueryClient(createD1Facade(sqlite)),
		bucket,
	};
}

const base = {
	organizationId: "org-1",
	createdByKind: "user" as const,
	createdById: "u-1",
	createdAt: "2026-11-04",
};
const content = '\ufeff{"kind":"document","blocks":[]}\r\nGrüße 🌍  ';
const output = {
	...base,
	workspaceId: "ws-1",
	id: "11111111-1111-4111-8111-111111111111",
	kind: "document" as const,
	title: "Test",
	currentRevisionId: "22222222-2222-4222-8222-222222222222",
	updatedAt: base.createdAt,
};
const revision = {
	...base,
	id: output.currentRevisionId,
	outputId: output.id,
	revision: 1,
	content,
};
const workspace = {
	...base,
	id: "ws-1",
	name: "Test",
	updatedAt: base.createdAt,
};

async function write(path: string, f: ReturnType<typeof fixture>) {
	if (path === "file")
		return confirmOsWorkspaceFile(f.db, { output, revision }, f.bucket);
	return instantiateOsBlueprint(
		f.db,
		{
			workspace,
			gadgets: [],
			revisions: [],
			...(path === "blueprint"
				? { outputs: [output], outputRevisions: [revision] }
				: {
						provisioning: {
							projects: [],
							epics: [],
							items: [],
							relations: [],
							epicItems: [],
							outputs: [output],
							outputRevisions: [revision],
							projectLinks: [],
							schedules: [],
						},
					}),
		},
		f.bucket,
	);
}

describe.each(["file", "blueprint", "provisioning"])(
	"%s output writer",
	(path) => {
		it("stores object rows with R2 pointers and hydrates exact evidence bytes", async () => {
			const f = fixture();
			await write(path, f);
			const row = await readObjectRevision(f.tenant, {
				organizationId: base.organizationId,
				revisionId: revision.id,
			});
			const digest = await sha256Hex(content);
			expect(row).toMatchObject({
				content: "",
				contentSha256: digest,
				contentBytes: new TextEncoder().encode(content).byteLength,
				bodyR2Key: `os-output-revisions/v1/org-1/${digest}.gz`,
			});
			const hydrated = await hydrateOutputRevision(row!, f.bucket);
			expect(hydrated.content).toBe(content);
			expect(await sha256Hex(hydrated.content)).toBe(digest);
			for (const table of ["os_outputs", "os_output_revisions"])
				expect(
					f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
				).toBe(0);
			const evidence = await resolveWorkEvidenceReference(
				{
					organizationId: base.organizationId,
					db: f.db,
				} as unknown as BaseContext,
				`output://${output.id}/revisions/${revision.id}`,
			);
			expect(evidence.reference).toMatchObject({
				kind: "output_revision",
				digest,
			});
		});

		it("keeps document rows unchanged when the store is unavailable", async () => {
			const f = fixture();
			f.state.active = false;
			await expect(write(path, f)).rejects.toThrow(
				"Workspace store is unavailable",
			);
			expect(f.sqlite.prepare("SELECT id FROM os_workspaces").all()).toEqual(
				path === "file" ? [] : [{ id: workspace.id }],
			);
			if (path !== "file") expect(f.bucket.put).not.toHaveBeenCalled();
			for (const table of ["os_outputs", "os_output_revisions"])
				expect(
					f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
				).toBe(0);
			expect(
				f.objectSql.prepare("SELECT count(*) AS n FROM os_outputs").get()?.n,
			).toBe(0);
		});

		it("retains only the retryable directory when R2 fails", async () => {
			const f = fixture();
			f.bucket.put.mockRejectedValue(new Error("R2 unavailable"));
			await expect(write(path, f)).rejects.toThrow("R2 unavailable");
			expect(f.sqlite.prepare("SELECT id FROM os_workspaces").all()).toEqual(
				path === "file" ? [] : [{ id: workspace.id }],
			);
			for (const table of ["os_outputs", "os_output_revisions"])
				expect(
					f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
				).toEqual({ n: 0 });
		});
	},
);

describe("uploaded document routing", () => {
	it("keeps repeated and concurrent confirmations idempotent", async () => {
		const f = fixture();
		await Promise.all([write("file", f), write("file", f)]);
		await write("file", f);
		for (const table of ["os_outputs", "os_output_revisions"])
			expect(
				f.objectSql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,
			).toBe(1);
	});
	it("rejects a mismatched output/revision before storing a body", async () => {
		const f = fixture();
		await expect(
			confirmOsWorkspaceFile(
				f.db,
				{ output, revision: { ...revision, outputId: "wrong" } },
				f.bucket,
			),
		).rejects.toThrow("scope mismatch");
		expect(f.bucket.put).not.toHaveBeenCalled();
	});
});

describe("blueprint document validation", () => {
	it.each(["wrong-workspace", "missing-revision", "orphan-revision"])(
		"rejects %s before storing bodies",
		async (invalid) => {
			const f = fixture();
			await expect(
				instantiateOsBlueprint(
					f.db,
					{
						workspace,
						gadgets: [],
						revisions: [],
						outputs:
							invalid === "orphan-revision"
								? []
								: [
										{
											...output,
											workspaceId:
												invalid === "wrong-workspace" ? "other" : workspace.id,
										},
									],
						outputRevisions: invalid === "missing-revision" ? [] : [revision],
					},
					f.bucket,
				),
			).rejects.toThrow("scope mismatch");
			expect(f.bucket.put).not.toHaveBeenCalled();
			expect(
				f.sqlite.prepare("SELECT count(*) AS n FROM os_workspaces").get()?.n,
			).toBe(0);
		},
	);
	it("requires initialization even for output-free blueprints", async () => {
		const f = fixture();
		delete (env as unknown as { WORKSPACE_RUNTIME?: unknown })
			.WORKSPACE_RUNTIME;
		await expect(
			instantiateOsBlueprint(
				f.db,
				{ workspace, gadgets: [], revisions: [] },
				f.bucket,
			),
		).rejects.toThrow("Workspace output runtime is unavailable");
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM os_workspaces").get()?.n,
		).toBe(1);
		expect(f.bucket.put).not.toHaveBeenCalled();
	});
});

it("writes resource-only Blueprint links to the object before its shared receipt", async () => {
	const f = fixture();
	const resource = {
		...base,
		id: "blueprint-resource",
		workspaceId: workspace.id,
		providerId: "example",
		connectionScope: "tenant" as const,
		resourceType: "folder",
		providerResourceId: "folder",
		name: "Sources",
		updatedAt: base.createdAt,
	};
	const query = f.runtime.outputQuery.bind(f.runtime);
	const calls = vi
		.spyOn(f.runtime, "outputQuery")
		.mockImplementation(async (scope, input) => {
			if (input.op === "resources")
				throw new Error("resource write unavailable");
			return query(scope, input);
		});
	const params = {
		workspace,
		gadgets: [],
		revisions: [],
		resources: [resource],
	};
	await expect(instantiateOsBlueprint(f.db, params, f.bucket)).rejects.toThrow(
		"resource write unavailable",
	);
	expect(
		f.sqlite.prepare("SELECT count(*) n FROM os_workspace_resources").get()?.n,
	).toBe(0);
	calls.mockImplementation(query);
	const result = await instantiateOsBlueprint(f.db, params, f.bucket);
	expect(result.resources).toHaveLength(1);
	expect(
		f.objectSql.prepare("SELECT id, name FROM os_workspace_resources").all(),
	).toEqual([{ id: resource.id, name: resource.name }]);
	expect(
		f.sqlite.prepare("SELECT id, name FROM os_workspace_resources").all(),
	).toEqual([{ id: resource.id, name: resource.name }]);
});
