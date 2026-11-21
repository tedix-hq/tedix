/**
 * A tedi's core memory through the API, called the way the tedi runtime
 * calls it (trusted service binding with exactly
 * `TEDI_RUNTIME_SERVICE_BINDING_SCOPES`) and the way a signed-in person does.
 */

import { createRouterClient } from "@orpc/server";
import {
	TEDI_CORE_MEMORY_LIMIT,
	TEDI_MEMORY_SCOPE,
} from "@tedix/api-contract/schemas/tedi-memory";
import { createDbClient } from "@tedix/db/client";
import { tediMemoryDocuments } from "@tedix/db/schema/tedi-memory";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	describe,
	expect,
	it,
	onTestFinished,
} from "vite-plus/test";
import { installOrganizationLogFixture } from "../../../test/organization-log-fixture";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../tedi-runtime/src/platform-client-factory";
import {
	getChangeRecord,
	listChangeRecords,
} from "../../services/organization-log";
import type { BaseContext } from "../orpc";
import { tediMemoryContractRouter } from "./tedi-memory";

const ORG = "00000000-0000-4000-8000-000000000401";
const OTHER_ORG = "00000000-0000-4000-8000-000000000402";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() + schemaDdl(tedis, tediMemoryDocuments),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${ORG}','Example','example'),('${OTHER_ORG}','Other','other');
		INSERT INTO tedis(id,organization_id,name,slug,status,mcp_capability_profile) VALUES
			('mine','${ORG}','Mine','mine','active','standard'),
			('colleague','${ORG}','Colleague','colleague','active','standard'),
			('elsewhere','${OTHER_ORG}','Elsewhere','elsewhere','active','standard');`);
	const facade = createD1Facade(sqlite);
	const store = installOrganizationLogFixture();
	const base = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/tediMemory"),
	};
	const runtime = (
		tediId: string,
		organizationId = ORG,
		scopes: readonly string[] = TEDI_RUNTIME_SERVICE_BINDING_SCOPES,
	) =>
		createRouterClient(tediMemoryContractRouter, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": organizationId,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Caller": "brain-bridge",
					"X-Tedix-Caller-Source": "http-platform-client",
					"X-Tedix-Tedi-Scopes": scopes.join(" "),
				}),
			} as BaseContext,
		});
	const person = (userRole: string, organizationId = ORG) =>
		createRouterClient(tediMemoryContractRouter, {
			context: {
				...base,
				headers: new Headers(),
				organizationId,
				authType: "user",
				userId: `${userRole}-user`,
				userRole,
				user: { sub: `${userRole}-sub` },
			} as BaseContext,
		});
	return { sqlite, store, runtime, person };
}

const edit = (text: string, mode: "replace" | "append" = "replace") => ({
	tediId: "mine",
	section: "project" as const,
	mode,
	text,
});

describe("tedi core memory", () => {
	it("lets a tedi read, replace and add to its own memory, one version per change", async () => {
		const { sqlite, store, runtime, person } = fixture();
		const mine = runtime("mine");

		await expect(mine.readCore({ tediId: "mine" })).resolves.toMatchObject({
			version: 0,
			usedChars: 0,
			limitChars: TEDI_CORE_MEMORY_LIMIT,
		});
		await mine.editCore(edit("Ships on Fridays."));
		const added = await mine.editCore({
			...edit("Reviews go to the reviewer first.", "append"),
			origin: "reflection",
		});
		expect(added.status).toBe("saved");
		expect(added.memory.version).toBe(2);
		const rows = sqlite
			.prepare("SELECT revision FROM tedi_memory_documents ORDER BY version")
			.all() as { revision: string }[];
		for (const row of rows) {
			const revision = JSON.parse(row.revision);
			const change = store
				.records(ORG)
				.find((record) => record.id === revision.provenance.changeRecordId);
			expect(change).toMatchObject({
				operation: "write",
				outcome: "applied",
				after: { revisionId: revision.revisionId, hash: revision.hash },
				decision: { verdict: "allow", riskTier: "bounded_write" },
			});
		}
		expect(JSON.parse(rows[1]!.revision).provenance.source.surface).toBe(
			"tedi_memory_reflection",
		);
		expect(
			added.memory.sections.find((section) => section.key === "project")?.text,
		).toBe("Ships on Fridays.\nReviews go to the reviewer first.");
		// The same text again is not a new version.
		await expect(
			mine.editCore(edit(added.memory.sections[1]!.text)),
		).resolves.toMatchObject({ status: "unchanged" });

		const history = await person("owner").listCoreVersions({ tediId: "mine" });
		expect(
			history.versions.map((entry) => [
				entry.version,
				entry.changedBy,
				entry.change,
			]),
		).toEqual([
			[2, { type: "reflection", id: "mine" }, 'Added to "This project"'],
			[1, { type: "tedi", id: "mine" }, 'Replaced "This project"'],
		]);
	});

	it("refuses an edit over the limit, a secret and pasted output, and changes nothing", async () => {
		const { sqlite, runtime } = fixture();
		const mine = runtime("mine");
		await mine.editCore(edit("a".repeat(TEDI_CORE_MEMORY_LIMIT - 10)));

		const over = await mine.editCore({
			tediId: "mine",
			section: "lessons",
			mode: "append",
			text: "b".repeat(11),
		});
		expect(over.status).toBe("refused");
		expect(over.reason).toContain(`${TEDI_CORE_MEMORY_LIMIT} characters`);
		expect(over.reason).toContain(`${TEDI_CORE_MEMORY_LIMIT + 1}`);

		for (const text of [
			"The deploy key is sk-proj-abcdefghijklmnopqrstuvwxyz012345",
			"password = hunter2hunter2hunter2",
			"The log said:\n```\n$ bun test\n3 failed\n```",
		])
			await expect(
				mine.editCore({ ...edit(text), section: "lessons" }),
			).resolves.toMatchObject({ status: "refused" });

		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM tedi_memory_documents").get(),
		).toEqual({ n: 1 });
	});

	it("keeps a tedi out of every other tedi's memory", async () => {
		const { runtime } = fixture();
		await runtime("colleague").editCore({
			...edit("Private to the colleague."),
			tediId: "colleague",
		});
		const mine = runtime("mine");
		await expect(mine.readCore({ tediId: "colleague" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			mine.editCore({ ...edit("x"), tediId: "colleague" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// A tedi of another organization cannot be reached under this one.
		await expect(
			runtime("elsewhere").readCore({ tediId: "elsewhere" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(mine.readCore({ tediId: "mine" })).resolves.toMatchObject({
			version: 0,
		});
	});

	it("needs the narrow memory right to edit and never lets a tedi restore", async () => {
		const { runtime } = fixture();
		expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).toContain(TEDI_MEMORY_SCOPE);
		const without = runtime(
			"mine",
			ORG,
			TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
				(scope) => scope !== TEDI_MEMORY_SCOPE,
			),
		);
		await expect(without.editCore(edit("x"))).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await runtime("mine").editCore(edit("First."));
		await expect(
			runtime("mine").restoreCoreVersion({ tediId: "mine", version: 1 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			runtime("mine").listCoreVersions({ tediId: "mine" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets a person who may change tedis restore a version, within their organization", async () => {
		const { runtime, person } = fixture();
		const mine = runtime("mine");
		await mine.editCore(edit("First."));
		await mine.editCore(edit("Second."));

		await expect(
			person("member").restoreCoreVersion({ tediId: "mine", version: 1 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			person("owner", OTHER_ORG).listCoreVersions({ tediId: "mine" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		const restored = await person("owner").restoreCoreVersion({
			tediId: "mine",
			version: 1,
		});
		expect(restored.version).toBe(3);
		expect(restored.sections[1]!.text).toBe("First.");
		const history = await person("owner").listCoreVersions({ tediId: "mine" });
		expect(history.versions[0]).toMatchObject({
			version: 3,
			changedBy: { type: "user", id: "owner-user" },
			change: "Restored version 1",
		});
		await expect(
			person("owner").restoreCoreVersion({ tediId: "mine", version: 9 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("writes a note's provenance record to the organization's live log store", async () => {
		const { sqlite, store, runtime } = fixture();
		await expect(
			runtime("mine").writeNote({
				tediId: "mine",
				name: "release",
				description: "Release checks",
				content: "Release after checks pass.",
			}),
		).resolves.toEqual({ status: "saved" });
		const row = sqlite
			.prepare("SELECT revision FROM tedi_memory_documents")
			.get() as { revision: string };
		const revision = JSON.parse(row.revision);
		const listed = await listChangeRecords(ORG, {
			resource: "memory:tedi:mine:note:release",
		});
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: revision.provenance.changeRecordId,
			operation: "write",
			outcome: "applied",
			after: { revisionId: revision.revisionId, hash: revision.hash },
		});
		expect(
			await getChangeRecord(ORG, revision.provenance.changeRecordId),
		).toEqual(listed[0]);
		expect(await listChangeRecords(OTHER_ORG, {})).toEqual([]);
		expect(store.records(ORG)).toHaveLength(1);
	});

	it("lets a tedi write, open and remove its notes and shows only their names in the read", async () => {
		const { runtime } = fixture();
		const mine = runtime("mine");
		const note = {
			tediId: "mine",
			name: "deploy-steps",
			description: "How a release goes out, step by step",
			content: "Release from main after the checks pass.",
		};
		await expect(mine.writeNote(note)).resolves.toEqual({ status: "saved" });
		await expect(mine.readCore({ tediId: "mine" })).resolves.toMatchObject({
			notes: [{ name: "deploy-steps", description: note.description }],
		});
		await expect(
			mine.readNote({ tediId: "mine", name: "deploy-steps" }),
		).resolves.toMatchObject({ content: note.content, version: 1 });
		// Another tedi neither reads it nor sees it listed.
		await expect(
			runtime("colleague").readNote({ tediId: "mine", name: "deploy-steps" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(await runtime("colleague").readCore({ tediId: "colleague" })).notes,
		).toEqual([]);

		await expect(
			mine.writeNote({
				...note,
				content: "token: sk-proj-abcdefghijklmnopqrstuvwxyz012345",
			}),
		).resolves.toMatchObject({ status: "refused" });
		await expect(mine.writeNote({ ...note, content: "" })).resolves.toEqual({
			status: "removed",
		});
		await expect(
			mine.readNote({ tediId: "mine", name: "deploy-steps" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
