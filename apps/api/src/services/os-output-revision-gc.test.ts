import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { outputRevisionBodyKey } from "./os-output-revision-body-store";
import {
	runOutputRevisionBodyGc,
	sweepOutputRevisionBodies,
} from "./os-output-revision-gc";

const NOW = new Date("2026-11-04T12:00:00Z");
const hash = (n: number) => n.toString(16).padStart(64, "0");
function fixture() {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: true,
	});
	sqlite.exec(
		schemaDdl(organizations, osWorkspaces, osOutputs, osOutputRevisions),
	);
	sqlite.exec(
		`INSERT INTO organizations(id,name,slug) VALUES ('org-a','A','a'),('org-b','B','b');`,
	);
	const db = createDbClient(createD1Facade(sqlite));
	const objects = new Map<string, { key: string; uploaded: Date }>();
	const add = (org: string, n: number, ageHours = 25) => {
		const key = outputRevisionBodyKey(org, hash(n));
		objects.set(key, {
			key,
			uploaded: new Date(NOW.getTime() - ageHours * 3_600_000),
		});
		return key;
	};
	const root = (org: string, n: number, id: string) => {
		sqlite
			.prepare(`INSERT INTO os_outputs
			(id,organization_id,kind,title,created_by_kind,created_by_id,created_at,updated_at)
			VALUES(?,?,'document','Example','user','user-a',?,?)`)
			.run(id, org, NOW.toISOString(), NOW.toISOString());
		sqlite
			.prepare(`INSERT INTO os_output_revisions
			(id,organization_id,output_id,revision,content,content_sha256,created_by_kind,created_by_id,created_at)
			VALUES(?,?,?,1,'inline',?,'user','user-a',?)`)
			.run(id, org, id, hash(n), NOW.toISOString());
	};
	const bucket = {
		list: vi.fn(async ({ prefix, cursor, delimiter }: R2ListOptions) => {
			const matching = [...objects.values()]
				.filter((o) => o.key.startsWith(prefix ?? ""))
				.sort((a, b) => a.key.localeCompare(b.key));
			if (delimiter)
				return {
					objects: [],
					delimitedPrefixes: [
						...new Set(
							matching.map((o) => o.key.slice(0, o.key.lastIndexOf("/") + 1)),
						),
					],
					truncated: false,
				};
			// Small pages exercise cursor handling even when the requested limit is larger.
			const remaining = matching.filter((o) => !cursor || o.key > cursor);
			const page = remaining.slice(0, 2);
			return {
				objects: page,
				delimitedPrefixes: [],
				truncated: remaining.length > 2,
				cursor: page.at(-1)?.key,
			};
		}),
		head: vi.fn(async (key: string) => objects.get(key) ?? null),
		delete: vi.fn(async (key: string) => {
			objects.delete(key);
		}),
	};
	const input = {
		db,
		bucket: bucket as unknown as R2Bucket,
		now: NOW,
		organizationId: "org-a",
		dryRun: false,
	};
	return { sqlite, objects, add, root, bucket, input };
}

describe("output body garbage collection", () => {
	it("keeps shared and historical roots until the final revision disappears; removes only old orphans in this org", async () => {
		const f = fixture();
		const shared = f.add("org-a", 1);
		const orphan = f.add("org-a", 2);
		const recent = f.add("org-a", 3, 23);
		const boundary = f.add("org-a", 4, 24);
		const other = f.add("org-b", 2);
		f.root("org-a", 1, "history");
		f.root("org-a", 1, "another-output");
		// A root in another tenant must not protect this tenant's orphan.
		f.root("org-b", 2, "other");
		expect(
			await sweepOutputRevisionBodies({ ...f.input, dryRun: true }),
		).toEqual({ scanned: 4, eligible: 1, removed: 0 });
		expect(f.bucket.delete).not.toHaveBeenCalled();
		expect(await sweepOutputRevisionBodies(f.input)).toEqual({
			scanned: 4,
			eligible: 1,
			removed: 1,
		});
		expect(f.objects.has(orphan)).toBe(false);
		f.sqlite.exec("DELETE FROM os_output_revisions WHERE id='another-output'");
		await sweepOutputRevisionBodies(f.input);
		expect(f.objects.has(shared)).toBe(true);
		f.sqlite.exec("DELETE FROM os_output_revisions WHERE id='history'");
		await sweepOutputRevisionBodies(f.input);
		expect(f.objects.has(shared)).toBe(false);
		for (const key of [recent, boundary, other])
			expect(f.objects.has(key)).toBe(true);
		f.sqlite.close();
	});

	it("drops a deleted org's complete prefix, preserves retirement and other orgs, and logs preview before deletion", async () => {
		const f = fixture();
		const old = f.add("org-a", 1);
		const fresh = f.add("org-a", 2, 0);
		const other = f.add("org-b", 1);
		f.root("org-b", 1, "retained");
		f.root("org-a", 1, "deleted-with-org");
		f.sqlite.exec(
			`UPDATE organizations SET metadata='{"retiredAt":"2026-11-01"}' WHERE id='org-b'; DELETE FROM organizations WHERE id='org-a';`,
		);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const result = await runOutputRevisionBodyGc(f.input);
		expect(result).toEqual({ scanned: 3, eligible: 2, removed: 2 });
		expect(f.objects.has(old)).toBe(false);
		expect(f.objects.has(fresh)).toBe(false);
		expect(f.objects.has(other)).toBe(true);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
			event: "output_body_gc.preview",
			scanned: 2,
			eligible: 2,
			removed: 0,
		});
		expect(log.mock.invocationCallOrder[0]).toBeLessThan(
			f.bucket.delete.mock.invocationCallOrder[0]!,
		);
		log.mockRestore();
		f.sqlite.close();
	});

	it("retains bodies refreshed or referenced after listing", async () => {
		const f = fixture();
		const refreshed = f.add("org-a", 1);
		const referenced = f.add("org-a", 2);
		f.bucket.head.mockImplementation(async (key) => {
			if (key === refreshed) return { key, uploaded: NOW };
			f.root("org-a", 2, "late-root");
			return f.objects.get(key) ?? null;
		});
		expect((await sweepOutputRevisionBodies(f.input)).removed).toBe(0);
		expect(f.objects.has(referenced)).toBe(true);
		f.sqlite.close();
	});

	it("fails closed on a reference read error", async () => {
		const f = fixture();
		f.add("org-a", 1);
		f.sqlite.exec("DROP TABLE os_output_revisions");
		await expect(sweepOutputRevisionBodies(f.input)).rejects.toThrow();
		expect(f.bucket.delete).not.toHaveBeenCalled();
		f.sqlite.close();
	});
});
