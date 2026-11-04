import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osOutputs,
	osOutputRevisions,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import { getOsOutputRevision as readRevision } from "@tedix/db/queries/os-workspaces/outputs";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	confirmOsWorkspaceFile,
	instantiateOsBlueprint,
} from "./os-workspace-outputs";
import { hydrateOutputRevision } from "./os-output-revision-body-store";
import { resolveWorkEvidenceReference } from "./work-evidence-resolution";
import type { BaseContext } from "../rpc/orpc";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
	);
	sqlite.exec(
		schemaDdl(osWorkspaces, osOutputs, osOutputRevisions, osWorkspaceResources),
	);
	const objects = new Map<string, ArrayBuffer>();
	const bucket = {
		put: vi.fn(async (key: string, bytes: ArrayBuffer) => {
			objects.set(key, bytes);
		}),
		get: vi.fn(async (key: string) => {
			const bytes = objects.get(key);
			return bytes ? { arrayBuffer: async () => bytes } : null;
		}),
	};
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), bucket };
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
							milestones: [],
							items: [],
							relations: [],
							milestoneItems: [],
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
		it("persists R2 metadata and preserves exact inline and hydrated evidence bytes", async () => {
			const f = fixture();
			await write(path, f);
			const row = await readRevision(f.db, {
				organizationId: base.organizationId,
				revisionId: revision.id,
			});
			const digest = await sha256Hex(content);
			expect(row).toMatchObject({
				content,
				contentSha256: digest,
				contentBytes: new TextEncoder().encode(content).byteLength,
				bodyR2Key: `os-output-revisions/v1/org-1/${digest}.gz`,
			});
			const hydrated = await hydrateOutputRevision(
				{ ...row!, content: "" },
				f.bucket,
			);
			expect(hydrated.content).toBe(content);
			expect(await sha256Hex(hydrated.content)).toBe(digest);
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
			f.sqlite.close();
		});

		it("does not write D1 rows when R2 fails", async () => {
			const f = fixture();
			f.bucket.put.mockRejectedValue(new Error("R2 unavailable"));
			await expect(write(path, f)).rejects.toThrow("R2 unavailable");
			for (const table of [
				"os_outputs",
				"os_output_revisions",
				"os_workspaces",
			])
				expect(
					f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
				).toEqual({ n: 0 });
			f.sqlite.close();
		});
	},
);
