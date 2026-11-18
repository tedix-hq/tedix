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
import { sweepDeletedOrganizationOutputAssets } from "./os-output-asset-gc";

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
							matching.map((o) =>
								o.key.slice(0, o.key.indexOf("/", (prefix ?? "").length) + 1),
							),
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
		delete: vi.fn(async (keys: string | string[]) => {
			for (const key of [keys].flat()) objects.delete(key);
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

describe("output asset garbage collection", () => {
	it("keeps all revision bodies while cleaning only a deleted organization's assets", async () => {
		const f = fixture();
		const old = f.add("org-a", 1);
		const fresh = f.add("org-a", 2, 0);
		const other = f.add("org-b", 1);
		f.root("org-b", 1, "retained");
		f.root("org-a", 1, "deleted-with-org");
		f.sqlite.exec(
			`UPDATE organizations SET metadata='{"retiredAt":"2026-11-01"}' WHERE id='org-b'; DELETE FROM organizations WHERE id='org-a';`,
		);
		// Images stored with files: only the deleted organization's go.
		const image = (org: string) => {
			const key = `os-output-assets/v1/${org}/out-1/${hash(9)}`;
			f.objects.set(key, { key, uploaded: NOW });
			return key;
		};
		const orphanImage = image("org-a");
		const keptImage = image("org-b");
		expect(await sweepDeletedOrganizationOutputAssets(f.input)).toBe(1);
		expect(f.objects.has(orphanImage)).toBe(false);
		expect(f.objects.has(keptImage)).toBe(true);
		expect(f.objects.has(old)).toBe(true);
		expect(f.objects.has(fresh)).toBe(true);
		expect(f.objects.has(other)).toBe(true);
		expect(
			f.bucket.list.mock.calls.every(([options]) =>
				options.prefix?.startsWith("os-output-assets/v1/"),
			),
		).toBe(true);
		f.sqlite.close();
	});
});
