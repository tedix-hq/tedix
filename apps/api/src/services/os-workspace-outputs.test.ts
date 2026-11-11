import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osOutputs,
	osOutputRevisions,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { listOsOutputRevisions } from "@tedix/db/queries/os-workspaces/outputs";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	createOsOutput,
	createOsOutputRevision,
	getOsOutputRevision,
} from "./os-workspace-outputs";

const notices = vi.hoisted(() => ({ notifyOutputRevision: vi.fn() }));
vi.mock("./os-output-revision-notice", () => notices);

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"PRAGMA foreign_keys = ON; CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
	);
	sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const objects = new Map<string, ArrayBuffer>();
	const revisionCountsAtWrite: number[] = [];
	const storage = {
		async put(key: string, value: ArrayBuffer) {
			revisionCountsAtWrite.push(
				Number(
					sqlite.prepare("SELECT count(*) AS n FROM os_output_revisions").get()
						?.n,
				),
			);
			objects.set(key, value);
		},
		async get(key: string) {
			const value = objects.get(key);
			return value ? { arrayBuffer: async () => value } : null;
		},
	};
	const accountability = {
		organizationId: "org-1",
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: "2026-01-01",
	};
	const output = {
		...accountability,
		id: "out-1",
		kind: "document" as const,
		title: "Example",
		status: "active" as const,
		currentRevisionId: "rev-1",
		updatedAt: "2026-01-01",
	};
	const revision = {
		...accountability,
		id: "rev-1",
		outputId: "out-1",
		revision: 1,
		content: '{"kind":"document","blocks":[]}',
		accessEnvelope: '{"version":1,"sources":[]}',
	};
	return {
		sqlite,
		db,
		objects,
		storage,
		output,
		revision,
		revisionCountsAtWrite,
	};
}

describe("output body persistence", () => {
	it("writes R2 before create/append, keeps inline bytes, hydrates R2 and lists only metadata", async () => {
		const f = fixture();
		try {
			const first = await createOsOutput(f.db, f.output, f.revision, f.storage);
			expect(first.revision.content).toBe(f.revision.content);
			expect(first.revision.contentSha256).toBe(
				await sha256Hex(f.revision.content),
			);
			const content =
				'{"kind":"document","blocks":[{"type":"paragraph","text":"Grüße 🌍"}]}';
			const next = await createOsOutputRevision(
				f.db,
				{ ...f.revision, id: "rev-2", content, expectedRevision: 1 },
				f.storage,
			);
			expect(next.ok).toBe(true);
			if (!next.ok) throw new Error("append failed");
			expect(next.revision.content).toBe(content);
			// Everyone with the file open is told of the new revision, by id.
			expect(notices.notifyOutputRevision).toHaveBeenLastCalledWith(
				expect.objectContaining({ db: f.db }),
				expect.objectContaining({ id: "out-1", organizationId: "org-1" }),
				{ outputId: "out-1", revisionId: "rev-2", revision: 2 },
			);
			expect(f.objects.has(next.revision.bodyR2Key!)).toBe(true);
			expect(f.revisionCountsAtWrite).toEqual([0, 1]);
			const metadata = await listOsOutputRevisions(f.db, {
				organizationId: "org-1",
				outputId: "out-1",
			});
			expect(metadata).toHaveLength(2);
			expect(metadata.every((row) => !("content" in row))).toBe(true);
			f.sqlite
				.prepare(
					"UPDATE os_output_revisions SET content = '' WHERE id = 'rev-2'",
				)
				.run();
			expect(
				(
					await getOsOutputRevision(
						f.db,
						{ organizationId: "org-1", revisionId: "rev-2" },
						f.storage,
					)
				)?.content,
			).toBe(content);
			expect(
				await getOsOutputRevision(
					f.db,
					{ organizationId: "org-2", revisionId: "rev-2" },
					f.storage,
				),
			).toBeUndefined();
		} finally {
			f.sqlite.close();
		}
	});

	it("refuses a body over the shared content limit before storing anything", async () => {
		const f = fixture();
		try {
			// Two bytes a letter: 8,000,002 bytes in 4,000,001 characters.
			const content = "é".repeat(4_000_001);
			await expect(
				createOsOutput(f.db, f.output, { ...f.revision, content }, f.storage),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining("over the 8 MB limit"),
			});
			await createOsOutput(f.db, f.output, f.revision, f.storage);
			await expect(
				createOsOutputRevision(
					f.db,
					{ ...f.revision, id: "rev-2", content, expectedRevision: 1 },
					f.storage,
				),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(f.objects.size).toBe(1);
			expect(
				await createOsOutputRevision(
					f.db,
					{
						...f.revision,
						id: "rev-2",
						content: "é".repeat(4_000_000),
						expectedRevision: 1,
					},
					f.storage,
				),
			).toMatchObject({ ok: true });
		} finally {
			f.sqlite.close();
		}
	});

	it("keeps revision ids and digests on no-op saves and leaves CAS conflicts uncommitted", async () => {
		const f = fixture();
		try {
			const first = await createOsOutput(f.db, f.output, f.revision, f.storage);
			const same = await createOsOutputRevision(
				f.db,
				{ ...f.revision, id: "unused", expectedRevision: 1 },
				f.storage,
			);
			expect(same).toMatchObject({
				ok: true,
				revision: {
					id: first.revision.id,
					contentSha256: first.revision.contentSha256,
				},
			});
			const conflict = await createOsOutputRevision(
				f.db,
				{
					...f.revision,
					id: "conflict",
					content: "new bytes",
					expectedRevision: 99,
				},
				f.storage,
			);
			expect(conflict).toEqual({ ok: false, reason: "revision_conflict" });
			expect(
				f.sqlite.prepare("SELECT count(*) AS n FROM os_output_revisions").get()
					?.n,
			).toBe(1);
			expect(f.objects.size).toBe(2);
		} finally {
			f.sqlite.close();
		}
	});

	it("never inserts or advances a row when R2 fails", async () => {
		const f = fixture();
		try {
			const failed = {
				...f.storage,
				put: async () => {
					throw new Error("R2 unavailable");
				},
			};
			await expect(
				createOsOutput(f.db, f.output, f.revision, failed),
			).rejects.toThrow("R2 unavailable");
			expect(
				f.sqlite.prepare("SELECT count(*) AS n FROM os_outputs").get()?.n,
			).toBe(0);
			await createOsOutput(f.db, f.output, f.revision, f.storage);
			await expect(
				createOsOutputRevision(
					f.db,
					{ ...f.revision, id: "rev-2", content: "changed" },
					failed,
				),
			).rejects.toThrow("R2 unavailable");
			expect(
				f.sqlite.prepare("SELECT current_revision_id FROM os_outputs").get()
					?.current_revision_id,
			).toBe("rev-1");
			expect(
				f.sqlite.prepare("SELECT count(*) AS n FROM os_output_revisions").get()
					?.n,
			).toBe(1);
		} finally {
			f.sqlite.close();
		}
	});
});
