import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import {
	tenantToolPolicies,
	tenantToolPolicyMountRevisions,
	tenantToolPolicyPreparations,
} from "../schema/tenant-tool-policy";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	consumeTenantToolPolicyPreparation,
	createTenantToolPolicy,
	replaceTenantToolPolicy,
	createTenantToolPolicyPreparation,
	findTenantToolPolicyRevisions,
	findTenantToolPolicyCandidatesBySource,
	findTenantToolPolicySubjectFences,
	tenantPolicySubjectKey,
	hasTenantToolPolicyFenceForSource,
	listDeletedTenantPolicyFences,
	revokeTenantToolPolicy,
} from "./tenant-tool-policy";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tenantToolPolicies));
	sqlite.exec(schemaDdl(tenantToolPolicyMountRevisions));
	sqlite.exec(schemaDdl(tenantToolPolicyPreparations));
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("tenant tool policy persistence", () => {
	it.each([
		["revoked", "revoked"],
		["revoked", "deleted"],
		["deleted", "revoked"],
		["deleted", "deleted"],
	] as const)(
		"recovers unknown %s and subject %s only with both current CAS fences",
		async (unknownMode, subjectMode) => {
			const db = fixture();
			const base = {
				organizationId: "org",
				appId: "source",
				rootAppId: "root",
				mountedToolId: "mount",
				toolRowId: "tool",
				toolDigest: "t",
				ruleDigest: "r",
				predicate: {},
				effect: {},
				createdBy: "owner",
			};
			const descriptor = { kind: "profile", actorUserId: "owner" };
			await replaceTenantToolPolicy(
				db,
				{
					...base,
					id: "subject",
					mountDescriptor: descriptor,
					createdAt: "2026-01-01T00:00:00.001Z",
				},
				null,
			);
			await createTenantToolPolicy(db, {
				...base,
				id: "unknown",
				createdAt: "2026-01-01T00:00:00.002Z",
			});
			for (const [id, mode] of [
				["subject", subjectMode],
				["unknown", unknownMode],
			] as const) {
				if (mode === "revoked")
					await revokeTenantToolPolicy(
						db,
						{ organizationId: "org", id },
						"2026-01-02",
					);
				else
					await db
						.delete(tenantToolPolicies)
						.where(eq(tenantToolPolicies.id, id));
			}
			const row = { ...base, mountDescriptor: descriptor };
			const attempt = (
				id: string,
				subject: string,
				unknown: string,
				selectedMode: "revoked" | "deleted" | null,
				ms: string,
			) =>
				replaceTenantToolPolicy(
					db,
					{ ...row, id, createdAt: `2026-01-01T00:00:00.${ms}Z` },
					subject,
					unknownMode === "revoked",
					unknownMode === "deleted",
					unknown,
					selectedMode,
				);
			expect(
				await attempt("bad-subject", "stale", "unknown", subjectMode, "003"),
			).toBeUndefined();
			expect(
				await attempt("bad-unknown", "subject", "stale", subjectMode, "004"),
			).toBeUndefined();
			expect(
				await attempt(
					"bad-mode",
					"subject",
					"unknown",
					subjectMode === "revoked" ? "deleted" : "revoked",
					"005",
				),
			).toBeUndefined();
			expect(
				await attempt("no-mode", "subject", "unknown", null, "006"),
			).toBeUndefined();
			const results = await Promise.all([
				attempt("one", "subject", "unknown", subjectMode, "007"),
				attempt("two", "subject", "unknown", subjectMode, "008"),
			]);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(
				(
					await findTenantToolPolicySubjectFences(db, {
						organizationId: "org",
						rootAppId: "root",
						mountedToolId: "mount",
					})
				).map((fence) => fence.policyId),
			).toEqual([results.find(Boolean)!.id]);
		},
	);
	it("requires a current subject CAS and permits only one concurrent unknown recovery", async () => {
		const db = fixture();
		const base = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "t",
			ruleDigest: "r",
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		const descriptor = { kind: "profile", actorUserId: "owner" };
		await replaceTenantToolPolicy(
			db,
			{
				...base,
				id: "subject",
				mountDescriptor: descriptor,
				createdAt: "2026-01-01T00:00:00.001Z",
			},
			null,
		);
		await createTenantToolPolicy(db, {
			...base,
			id: "unknown",
			createdAt: "2026-01-01T00:00:00.002Z",
		});
		await revokeTenantToolPolicy(
			db,
			{ organizationId: "org", id: "unknown" },
			"2026-01-02",
		);
		const row = { ...base, mountDescriptor: descriptor };
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "stale", createdAt: "2026-01-01T00:00:00.003Z" },
				"wrong",
				true,
				false,
				"unknown",
			),
		).toBeUndefined();
		const results = await Promise.all([
			replaceTenantToolPolicy(
				db,
				{ ...row, id: "one", createdAt: "2026-01-01T00:00:00.004Z" },
				"subject",
				true,
				false,
				"unknown",
			),
			replaceTenantToolPolicy(
				db,
				{ ...row, id: "two", createdAt: "2026-01-01T00:00:00.005Z" },
				"subject",
				true,
				false,
				"unknown",
			),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(
			(
				await findTenantToolPolicySubjectFences(db, {
					organizationId: "org",
					rootAppId: "root",
					mountedToolId: "mount",
				})
			).map((fence) => fence.policyId),
		).toEqual([results.find(Boolean)!.id]);
	});
	it.each(["revoked", "deleted"] as const)(
		"retires only the reviewed latest unknown %s fence",
		async (mode) => {
			const db = fixture();
			const base = {
				organizationId: "org",
				appId: "source",
				rootAppId: "root",
				mountedToolId: "mount",
				toolRowId: "tool",
				toolDigest: "t",
				ruleDigest: "r",
				predicate: {},
				effect: {},
				createdBy: "owner",
			};
			await createTenantToolPolicy(db, {
				...base,
				id: "legacy",
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			const descriptor = {
				kind: "profile",
				actorUserId: "owner",
				mount: { sourceToolId: "edit" },
			};
			const replacement = {
				...base,
				id: "fresh",
				mountDescriptor: descriptor,
				createdAt: "2026-01-01T00:00:00.001Z",
			};
			const scope = {
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "mount",
			};
			expect(
				await replaceTenantToolPolicy(
					db,
					replacement,
					null,
					mode === "revoked",
					mode === "deleted",
					"legacy",
				),
			).toBeUndefined();
			if (mode === "revoked")
				await revokeTenantToolPolicy(
					db,
					{ organizationId: "org", id: "legacy" },
					"2026-01-02T00:00:00Z",
				);
			else
				await db
					.delete(tenantToolPolicies)
					.where(eq(tenantToolPolicies.id, "legacy"));
			expect(
				await replaceTenantToolPolicy(db, replacement, null),
			).toBeUndefined();
			expect(
				await replaceTenantToolPolicy(
					db,
					replacement,
					null,
					mode === "revoked",
					mode === "deleted",
					"wrong",
				),
			).toBeUndefined();
			expect(
				await replaceTenantToolPolicy(
					db,
					replacement,
					null,
					mode === "revoked",
					mode === "deleted",
					"legacy",
				),
			).toMatchObject({ id: "fresh" });
			expect(await findTenantToolPolicySubjectFences(db, scope)).toEqual([
				expect.objectContaining({
					subjectKey: tenantPolicySubjectKey(descriptor),
					policyId: "fresh",
				}),
			]);
			expect(
				await replaceTenantToolPolicy(
					db,
					{
						...replacement,
						id: "reused",
						createdAt: "2026-01-01T00:00:00.002Z",
					},
					"fresh",
					mode === "revoked",
					mode === "deleted",
					"legacy",
				),
			).toBeUndefined();
			await db
				.delete(tenantToolPolicies)
				.where(eq(tenantToolPolicies.id, "fresh"));
			expect(await findTenantToolPolicySubjectFences(db, scope)).toEqual([
				expect.objectContaining({ policyId: "fresh", policyRowId: null }),
			]);
			await createTenantToolPolicy(db, {
				...base,
				id: "later-unknown",
				createdAt: "2026-01-01T00:00:00.003Z",
			});
			expect(await findTenantToolPolicySubjectFences(db, scope)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						subjectKey: null,
						policyId: "later-unknown",
					}),
				]),
			);
		},
	);
	it("rolls back the new revision if its durable fence cannot be written", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF");
			sqlite.exec(schemaDdl(tenantToolPolicies));
			sqlite.exec(schemaDdl(tenantToolPolicyMountRevisions));
			sqlite.exec(
				"CREATE TRIGGER reject_fence BEFORE INSERT ON tenant_tool_policy_mount_revisions BEGIN SELECT RAISE(ABORT, 'fence failed'); END",
			);
			const db = createDbQueryClient(createD1Facade(sqlite));
			await expect(
				replaceTenantToolPolicy(
					db,
					{
						id: "new",
						organizationId: "org",
						appId: "source",
						rootAppId: "root",
						mountedToolId: "mount",
						toolRowId: "tool",
						toolDigest: "t",
						ruleDigest: "r",
						predicate: {},
						effect: {},
						mountDescriptor: { kind: "profile", actorUserId: "owner" },
						createdBy: "owner",
						createdAt: "2026-01-01",
					},
					null,
				),
			).rejects.toThrow();
			expect(
				sqlite
					.prepare("SELECT COUNT(*) AS count FROM tenant_tool_policies")
					.get(),
			).toMatchObject({ count: 0 });
		} finally {
			sqlite.close();
		}
	});
	it("backfills recognized subject fences and leaves missing or malformed revisions unknown", () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(
				"CREATE TABLE tenant_tool_policies (id TEXT, organization_id TEXT, mount_descriptor TEXT); CREATE TABLE tenant_tool_policy_mount_revisions (policy_id TEXT, organization_id TEXT)",
			);
			const insert = sqlite.prepare(
				"INSERT INTO tenant_tool_policies VALUES (?, ?, ?)",
			);
			const user = { kind: "profile", actorUserId: "owner" };
			const machine = {
				kind: "machine",
				subject: {
					scope: "session",
					principalId: "p",
					mcpServerId: "s",
					sessionId: "session",
					clientRecordId: "client",
				},
			};
			insert.run("user", "org", JSON.stringify(user));
			insert.run("machine", "org", JSON.stringify(machine));
			insert.run("invalid", "org", "{bad json");
			for (const id of ["user", "machine", "invalid", "deleted"])
				sqlite
					.prepare(
						"INSERT INTO tenant_tool_policy_mount_revisions VALUES (?, ?)",
					)
					.run(id, "org");
			const migration = readFileSync(
				new URL(
					"../../drizzle/20261030163804_tenant_policy_subjects/migration.sql",
					import.meta.url,
				),
				"utf8",
			);
			sqlite.exec(migration);
			const rows = sqlite
				.prepare(
					"SELECT policy_id, subject_key FROM tenant_tool_policy_mount_revisions ORDER BY policy_id",
				)
				.all();
			expect(rows).toEqual([
				expect.objectContaining({ policy_id: "deleted", subject_key: null }),
				expect.objectContaining({ policy_id: "invalid", subject_key: null }),
				expect.objectContaining({
					policy_id: "machine",
					subject_key: tenantPolicySubjectKey(machine),
				}),
				expect.objectContaining({
					policy_id: "user",
					subject_key: tenantPolicySubjectKey(user),
				}),
			]);
		} finally {
			sqlite.close();
		}
	});
	it("keeps separate subject revisions and tombstones on the same mount", async () => {
		const db = fixture();
		const base = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "t",
			ruleDigest: "r",
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		const user = {
			kind: "profile",
			actorUserId: "owner",
			mount: { sourceToolId: "edit" },
		};
		const machine = {
			kind: "machine",
			subject: { scope: "principal", principalId: "p", mcpServerId: "server" },
			mount: { sourceToolId: "edit" },
		};
		const userKey = tenantPolicySubjectKey(user)!;
		const machineKey = tenantPolicySubjectKey(machine)!;
		expect(
			await replaceTenantToolPolicy(
				db,
				{
					...base,
					id: "u1",
					mountDescriptor: user,
					createdAt: "2026-01-01T00:00:00.001Z",
				},
				null,
			),
		).toBeTruthy();
		expect(
			await replaceTenantToolPolicy(
				db,
				{
					...base,
					id: "m1",
					mountDescriptor: machine,
					createdAt: "2026-01-01T00:00:00.002Z",
				},
				null,
			),
		).toBeTruthy();
		expect(
			await replaceTenantToolPolicy(
				db,
				{
					...base,
					id: "u2",
					mountDescriptor: user,
					createdAt: "2026-01-01T00:00:00.003Z",
				},
				"u1",
			),
		).toBeTruthy();
		expect(
			await replaceTenantToolPolicy(
				db,
				{
					...base,
					id: "stale",
					mountDescriptor: user,
					createdAt: "2026-01-01T00:00:00.004Z",
				},
				"u1",
			),
		).toBeUndefined();
		await revokeTenantToolPolicy(
			db,
			{ organizationId: "org", id: "u2" },
			"2026-01-02T00:00:00Z",
		);
		const scope = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "mount",
		};
		expect(await findTenantToolPolicySubjectFences(db, scope)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subjectKey: userKey,
					policyId: "u2",
					revokedAt: "2026-01-02T00:00:00Z",
				}),
				expect.objectContaining({
					subjectKey: machineKey,
					policyId: "m1",
					revokedAt: null,
				}),
			]),
		);
		expect(
			(
				await findTenantToolPolicyRevisions(db, {
					...scope,
					subjectKey: machineKey,
				})
			)[0]?.id,
		).toBe("m1");
		await db.delete(tenantToolPolicies).where(eq(tenantToolPolicies.id, "u2"));
		expect(await findTenantToolPolicySubjectFences(db, scope)).toContainEqual(
			expect.objectContaining({
				subjectKey: userKey,
				policyId: "u2",
				policyRowId: null,
			}),
		);
		expect(
			(
				await findTenantToolPolicyCandidatesBySource(db, {
					organizationId: "org",
					sourceAppId: "source",
					sourceToolRowId: "tool",
					subjectKeys: [machineKey],
				})
			).map((r) => r.id),
		).toEqual(["m1"]);
	});
	it("consumes a reviewed preparation only once for its owner and organization", async () => {
		const db = fixture();
		await createTenantToolPolicyPreparation(db, {
			id: "p",
			organizationId: "org",
			ownerId: "owner",
			descriptor: {},
			descriptorDigest: "digest",
			expiresAt: "2026-10-30T14:10:00.000Z",
		});
		const valid = {
			id: "p",
			organizationId: "org",
			ownerId: "owner",
			descriptorDigest: "digest",
			now: "2026-10-30T14:00:00.000Z",
		};
		expect(
			await consumeTenantToolPolicyPreparation(db, {
				...valid,
				ownerId: "other",
			}),
		).toBeUndefined();
		expect(
			await consumeTenantToolPolicyPreparation(db, {
				...valid,
				organizationId: "other",
			}),
		).toBeUndefined();
		expect(
			await consumeTenantToolPolicyPreparation(db, {
				...valid,
				descriptorDigest: "different",
			}),
		).toBeUndefined();
		expect(
			await consumeTenantToolPolicyPreparation(db, {
				...valid,
				now: "2026-10-30T14:10:00.000Z",
			}),
		).toBeUndefined();
		expect(await consumeTenantToolPolicyPreparation(db, valid)).toMatchObject({
			id: "p",
		});
		expect(await consumeTenantToolPolicyPreparation(db, valid)).toBeUndefined();
	});
	it("keeps a revoked latest revision in order so older approvals cannot revive", async () => {
		const db = fixture();
		const row = {
			organizationId: "org",
			appId: "app",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "tool-hash",
			ruleDigest: "rule-hash",
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		await createTenantToolPolicy(db, {
			...row,
			id: "old",
			createdAt: "2026-10-30T14:00:00.000Z",
		});
		await createTenantToolPolicy(db, {
			...row,
			id: "new",
			appId: "other-source",
			toolRowId: "other-tool",
			createdAt: "2026-10-30T14:00:00.000Z",
		});
		await revokeTenantToolPolicy(
			db,
			{ organizationId: "org", id: "new" },
			"2026-10-30T14:01:00.000Z",
		);
		const revisions = await findTenantToolPolicyRevisions(db, {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "mount",
		});
		expect(revisions.map((revision) => revision.id)).toEqual(["new"]);
		expect(revisions[0]?.revokedAt).not.toBeNull();
		expect(
			await findTenantToolPolicyRevisions(db, {
				organizationId: "other",
				rootAppId: "root",
				mountedToolId: "mount",
			}),
		).toEqual([]);
		await db.delete(tenantToolPolicies).where(eq(tenantToolPolicies.id, "new"));
		expect(
			await findTenantToolPolicyRevisions(db, {
				organizationId: "org",
				rootAppId: "root",
				mountedToolId: "mount",
			}),
		).toEqual([]);
	});
	it("returns only current source mounts and detects ambiguous mounts", async () => {
		const db = fixture();
		const row = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount-a",
			toolRowId: "tool",
			toolDigest: "tool-hash",
			ruleDigest: "rule-hash",
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		await createTenantToolPolicy(db, {
			...row,
			id: "old",
			createdAt: "2026-10-30T14:00:00.000Z",
		});
		await createTenantToolPolicy(db, {
			...row,
			id: "latest",
			createdAt: "2026-10-30T14:00:00.001Z",
		});
		const scope = {
			organizationId: "org",
			rootAppId: "root",
			sourceAppId: "source",
			sourceToolRowId: "tool",
		};
		expect(
			(await findTenantToolPolicyCandidatesBySource(db, scope)).map(
				(item) => item.id,
			),
		).toEqual(["latest"]);
		await createTenantToolPolicy(db, {
			...row,
			id: "other-root",
			rootAppId: "root-two",
			createdAt: "2026-10-30T14:00:00.002Z",
		});
		expect(
			await findTenantToolPolicyCandidatesBySource(db, {
				organizationId: "org",
				sourceAppId: "source",
				sourceToolRowId: "tool",
			}),
		).toHaveLength(2);
		expect(
			await findTenantToolPolicyCandidatesBySource(db, scope),
		).toHaveLength(1);
		await createTenantToolPolicy(db, {
			...row,
			id: "second",
			mountedToolId: "mount-b",
			createdAt: "2026-10-30T14:00:00.003Z",
		});
		expect(
			await findTenantToolPolicyCandidatesBySource(db, scope),
		).toHaveLength(2);
		expect(
			await findTenantToolPolicyCandidatesBySource(db, {
				...scope,
				organizationId: "other",
			}),
		).toEqual([]);
	});
	it("keeps a source and mount fence after a policy is deleted or a tool is recreated", async () => {
		const db = fixture();
		const scope = {
			organizationId: "org",
			rootAppId: "root",
			mountedToolId: "mount",
			sourceAppId: "source",
			sourceToolRowId: "tool",
			sourceToolId: "write",
		};
		expect(await hasTenantToolPolicyFenceForSource(db, scope)).toBe(false);
		await createTenantToolPolicy(db, {
			id: "policy",
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "t",
			ruleDigest: "r",
			mountDescriptor: { mount: { sourceToolId: "write" } },
			predicate: {},
			effect: {},
			createdBy: "owner",
			createdAt: "2026-10-30T14:00:00Z",
		});
		await db
			.delete(tenantToolPolicies)
			.where(eq(tenantToolPolicies.id, "policy"));
		expect(await hasTenantToolPolicyFenceForSource(db, scope)).toBe(true);
		expect(
			await hasTenantToolPolicyFenceForSource(db, {
				...scope,
				sourceToolRowId: "recreated-tool",
			}),
		).toBe(true);
		expect(
			await hasTenantToolPolicyFenceForSource(db, {
				...scope,
				mountedToolId: "other-mount",
				sourceToolId: "search",
				sourceToolRowId: "search-row",
			}),
		).toBe(false);
		expect(
			await hasTenantToolPolicyFenceForSource(db, {
				...scope,
				organizationId: "other",
			}),
		).toBe(false);
	});
	it("replaces only the current unrevoked revision and rejects concurrent or revoked edits", async () => {
		const db = fixture();
		const row = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "t",
			ruleDigest: "r",
			mountDescriptor: { kind: "profile", actorUserId: "owner" },
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "first", createdAt: "2026-01-01T00:00:00.000Z" },
				null,
			),
		).toMatchObject({ id: "first" });
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "new-overwrite", createdAt: "2026-01-01T00:00:00.004Z" },
				null,
			),
		).toBeUndefined();
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "second", createdAt: "2026-01-01T00:00:00.001Z" },
				"first",
			),
		).toMatchObject({ id: "second" });
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "stale", createdAt: "2026-01-01T00:00:00.002Z" },
				"first",
			),
		).toBeUndefined();
		await revokeTenantToolPolicy(
			db,
			{ organizationId: "org", id: "second" },
			"2026-01-01T00:00:01Z",
		);
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "after-revoke", createdAt: "2026-01-01T00:00:00.003Z" },
				"second",
			),
		).toBeUndefined();
		expect(
			(
				await findTenantToolPolicyRevisions(db, {
					organizationId: "org",
					rootAppId: "root",
					mountedToolId: "mount",
				})
			)[0],
		).toMatchObject({ id: "second", revokedAt: "2026-01-01T00:00:01Z" });
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "wrong-regrant", createdAt: "2026-01-01T00:00:00.005Z" },
				"first",
				true,
			),
		).toBeUndefined();
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "new-grant", createdAt: "2026-01-01T00:00:00.006Z" },
				"second",
				true,
			),
		).toMatchObject({ id: "new-grant", revokedAt: null });
		expect(
			(
				await db
					.select()
					.from(tenantToolPolicies)
					.where(eq(tenantToolPolicies.id, "second"))
			)[0],
		).toMatchObject({ revokedAt: "2026-01-01T00:00:01Z" });
	});
	it("recovers a deleted latest revision only with a fresh explicit matching fence", async () => {
		const db = fixture();
		const row = {
			organizationId: "org",
			appId: "source",
			rootAppId: "root",
			mountedToolId: "mount",
			toolRowId: "tool",
			toolDigest: "t",
			ruleDigest: "r",
			mountDescriptor: { kind: "profile", actorUserId: "owner" },
			predicate: {},
			effect: {},
			createdBy: "owner",
		};
		await createTenantToolPolicy(db, {
			...row,
			id: "deleted",
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		await db
			.delete(tenantToolPolicies)
			.where(eq(tenantToolPolicies.id, "deleted"));
		expect(await listDeletedTenantPolicyFences(db, "org")).toMatchObject([
			{ rootAppId: "root", mountedToolId: "mount", revisionId: "deleted" },
		]);
		expect(await listDeletedTenantPolicyFences(db, "other")).toEqual([]);
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "ordinary", createdAt: "2026-01-01T00:00:00.001Z" },
				"deleted",
			),
		).toBeUndefined();
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "fresh", createdAt: "2026-01-01T00:00:00.002Z" },
				"deleted",
				false,
				true,
			),
		).toMatchObject({ id: "fresh" });
		expect(await listDeletedTenantPolicyFences(db, "org")).toEqual([]);
		expect(
			await replaceTenantToolPolicy(
				db,
				{ ...row, id: "stale", createdAt: "2026-01-01T00:00:00.003Z" },
				"deleted",
				false,
				true,
			),
		).toBeUndefined();
	});
});
