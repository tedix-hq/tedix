import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	encodeBase64,
	importVerifyingKey,
	verifyChain,
} from "@tedix/agent-governance/seal";
import type { GatewayChangeRecordBody } from "@tedix/api-contract/schemas/audit";
import { createDbClient } from "@tedix/db/client";
import type { OrganizationLogAppendInput } from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { installOrganizationLogFixture } from "../../../test/organization-log-fixture";
import type { BaseContext } from "../orpc";
import { auditContractRouter } from "./audit";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

it("stores gateway change records under the gateway's organization only", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		// No table exists: an append or list that looked anything up in the
		// main database would fail here. The organization's store holds them.
		const store = installOrganizationLogFixture();
		const db = createDbClient(createD1Facade(sqlite));
		const client = (
			orgId?: string,
			caller:
				| "gateway"
				| "tool-call"
				| "forwarded-tool"
				| "other-service"
				| "public" = "gateway",
		) =>
			createRouterClient(auditContractRouter, {
				context: {
					db,
					env: { ENVIRONMENT: "test" },
					headers: new Headers({
						...(caller === "public" ? {} : { "X-Service-Binding": "true" }),
						...(orgId ? { "X-Tedix-Org-Id": orgId } : {}),
						...(caller === "tool-call"
							? { "X-Tedix-Caller-Type": "mcp-edge-user" }
							: {}),
						...(caller === "forwarded-tool"
							? { "X-Tedix-Mcp-Tool-Id": "append_change_record" }
							: {}),
					}),
					...(caller !== "other-service" && caller !== "public"
						? { serviceBindingPrincipal: "mcp-edge" }
						: {}),
					url: new URL("https://api.tedix.test/rpc/audit"),
				} as BaseContext,
			});
		const first = client(ORG_A);
		const record = await first.appendChangeRecord({
			resource: "tool:get_example",
			operation: "get_example",
			actor: { id: "user-a", kind: "user", organizationId: "forged" },
			source: { surface: "mcp_gateway" },
			decision: {
				verdict: "allow",
				gate: "tool_scope",
				reason: "allowed",
				riskTier: "read",
				blastRadius: "none",
			},
			outcome: "applied",
			argsHash: "hash",
			undo: {
				kind: "compensating_call",
				call: {
					resource: "tool:get_example",
					operation: "get_example",
					args: { secret: "do-not-store" },
				},
			},
		} as Parameters<typeof first.appendChangeRecord>[0]);
		expect(record.actor.organizationId).toBe(ORG_A);
		expect(record.sequence).toBeGreaterThan(0);
		expect(await first.listChangeRecords({})).toEqual([record]);
		expect(await first.getChangeRecord({ id: record.id })).toEqual(record);
		const stored = store.records(ORG_A);
		expect(stored).toHaveLength(1);
		expect(store.records(ORG_B)).toEqual([]);
		expect(JSON.stringify(stored)).not.toContain("do-not-store");

		// The gateway may name the record; naming it twice stores it once.
		const named = {
			...record,
			id: "33333333-3333-4333-8333-333333333333",
			recordedAt: "2026-11-18T10:00:00.000Z",
			operation: "named",
		};
		const { sequence: _sequence, ...namedInput } = named;
		const storedNamed = await first.appendChangeRecord(namedInput);
		expect(storedNamed).toMatchObject({
			id: named.id,
			recordedAt: named.recordedAt,
			operation: "named",
		});
		expect(
			await first.appendChangeRecord({ ...namedInput, operation: "changed" }),
		).toEqual(storedNamed);
		expect(await first.listChangeRecords({})).toEqual([record, storedNamed]);
		await expect(
			first.appendChangeRecord({ ...namedInput, id: "not-a-uuid" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// `recorded_at` is stored in one form, so range reads can compare text.
		expect(
			await first.appendChangeRecord({
				...namedInput,
				id: "44444444-4444-4444-8444-444444444444",
				recordedAt: "2026-11-18T11:00:00+01:00",
			}),
		).toMatchObject({ recordedAt: "2026-11-18T10:00:00.000Z" });
		expect(
			await first.appendChangeRecord({
				...namedInput,
				id: "55555555-5555-4555-8555-555555555555",
				recordedAt: "2026-11-18T10:00:00Z",
			}),
		).toMatchObject({ recordedAt: "2026-11-18T10:00:00.000Z" });

		const other = client(ORG_B);
		expect(await other.listChangeRecords({})).toEqual([]);
		expect(await other.getChangeRecord({ id: record.id })).toBeNull();

		for (const refused of [
			client(),
			client("system"),
			client(ORG_A, "other-service"),
			client(ORG_A, "tool-call"),
			client(ORG_A, "forwarded-tool"),
		])
			await expect(refused.listChangeRecords({})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		await expect(
			client(ORG_A, "public").listChangeRecords({}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	} finally {
		sqlite.close();
	}
});

describe("owner and admin read of gateway change records", () => {
	const DAY = { from: "2026-11-18T00:00:00Z", until: "2026-11-19T00:00:00Z" };

	async function ledger() {
		// The member table's organization reference is not under test here.
		const sqlite = new DatabaseSync(":memory:", {
			enableForeignKeyConstraints: false,
		});
		sqlite.exec(schemaDdl(organizationMembers));
		const store = installOrganizationLogFixture();
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(organizationMembers).values(
			(
				[
					[ORG_A, "owner-a", "owner", "active"],
					[ORG_A, "admin-a", "admin", "active"],
					[ORG_A, "member-a", "member", "active"],
					[ORG_A, "viewer-a", "viewer", "active"],
					[ORG_A, "former-admin-a", "admin", "suspended"],
					[ORG_B, "owner-b", "owner", "active"],
				] as const
			).map(([organizationId, descopeUserId, role, status]) => ({
				id: `${organizationId}:${descopeUserId}`,
				organizationId,
				descopeUserId,
				email: `${descopeUserId}@example.test`,
				role,
				status,
			})),
		);
		const rows = [
			[ORG_A, "2026-11-17T23:59:59.999Z", "tool:get_example", "user-1"],
			[ORG_A, "2026-11-18T00:00:00.000Z", "tool:get_example", "user-1"],
			[ORG_B, "2026-11-18T09:00:00.000Z", "tool:get_example", "user-1"],
			[ORG_A, "2026-11-18T10:00:00.000Z", "tool:send_example", "user-1"],
			[ORG_A, "2026-11-18T11:00:00.000Z", "tool:get_example", "user-2"],
			[ORG_A, "2026-11-18T23:59:59.999Z", "tool:get_example", "user-1"],
			// One millisecond after the exclusive end.
			[ORG_A, "2026-11-19T00:00:00.001Z", "tool:get_example", "user-1"],
			[ORG_A, "2026-11-19T00:00:00.000Z", "tool:get_example", "user-1"],
		] as const;
		// Each organization's store numbers its own records from 1.
		for (const [index, [organizationId, recordedAt, resource, actorId]] of [
			...rows.entries(),
		])
			await store.runtime.organizationLogAppend(organizationId, {
				id: `00000000-0000-4000-8000-00000000000${index}`,
				recordedAt,
				resource,
				operation: resource.slice("tool:".length),
				actor: { id: actorId, kind: "user", organizationId },
				source: { surface: "mcp_gateway" },
				decision: {
					verdict: "allow",
					gate: "tool_scope",
					reason: "allowed",
					riskTier: "read",
					blastRadius: "none",
				},
				outcome: "applied",
				argsHash: `hash-${index}`,
			} as OrganizationLogAppendInput);
		const call = (context: Partial<BaseContext>) =>
			createRouterClient(auditContractRouter, {
				context: {
					db,
					env: { ENVIRONMENT: "test" },
					headers: new Headers(),
					url: new URL("https://api.tedix.test/rpc/audit"),
					...context,
				} as BaseContext,
			}).listGatewayChangeRecords;
		const member = (
			organizationId: string,
			sub: string,
			permissions = ["analytics:read"],
		) =>
			call({
				authType: "user",
				organizationId,
				user: { sub, permissions, roles: [] } as unknown as BaseContext["user"],
			});
		const machine = (scopes: string[], actingFor?: string) =>
			call({
				authType: "apikey",
				organizationId: ORG_A,
				descopeUserId: actingFor,
				apiKey: {
					id: "key",
					organizationId: ORG_A,
					name: "machine-key",
					scopes,
				} as BaseContext["apiKey"],
			});
		return { sqlite, member, machine };
	}

	it("returns only the caller's organization's records", async () => {
		const { sqlite, member } = await ledger();
		try {
			const own = await member(ORG_A, "owner-a")(DAY);
			expect(own).toMatchObject({
				from: "2026-11-18T00:00:00.000Z",
				until: "2026-11-19T00:00:00.000Z",
				count: 4,
				nextAfterSequence: null,
			});
			expect(own.records.map((record) => record.sequence)).toEqual([
				2, 3, 4, 5,
			]);
			expect(
				own.records.every((record) => record.actor.organizationId === ORG_A),
			).toBe(true);
			expect(own.records[0]).toMatchObject({ argsHash: "hash-1" });
			expect((await member(ORG_A, "admin-a")(DAY)).count).toBe(4);

			const other = await member(ORG_B, "owner-b")(DAY);
			expect(other.count).toBe(1);
			expect(other.records.map((record) => record.sequence)).toEqual([1]);

			// No input names an organization, and membership of one organization
			// gives nothing in another.
			await expect(
				member(
					ORG_A,
					"owner-a",
				)({ ...DAY, organizationId: ORG_B } as typeof DAY),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			await expect(member(ORG_B, "owner-a")(DAY)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(member(ORG_A, "owner-b")(DAY)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		} finally {
			sqlite.close();
		}
	});

	it("refuses everyone but an active owner or admin", async () => {
		const { sqlite, member, machine } = await ledger();
		try {
			for (const sub of ["member-a", "viewer-a", "former-admin-a", "stranger"])
				await expect(member(ORG_A, sub)(DAY)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			await expect(member(ORG_A, "owner-a", [])(DAY)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});

			// A machine caller needs the read scope and a member to act for.
			for (const refused of [
				machine(["analytics:read"]),
				machine(["analytics:read"], ""),
				machine(["analytics:read"], "member-a"),
				machine(["analytics:read"], "owner-b"),
				machine(["apps:read"], "owner-a"),
			])
				await expect(refused(DAY)).rejects.toMatchObject({
					code: "FORBIDDEN",
				});
			expect((await machine(["analytics:read"], "owner-a")(DAY)).count).toBe(4);
		} finally {
			sqlite.close();
		}
	});

	it("counts the whole range whatever the page, and ends the range before until", async () => {
		const { sqlite, member } = await ledger();
		try {
			const read = member(ORG_A, "owner-a");
			const first = await read({ ...DAY, limit: 3 });
			expect(first.count).toBe(4);
			expect(first.records.map((record) => record.sequence)).toEqual([2, 3, 4]);
			expect(first.nextAfterSequence).toBe(4);
			const second = await read({
				...DAY,
				limit: 3,
				afterSequence: first.nextAfterSequence ?? undefined,
			});
			expect(second.count).toBe(4);
			expect(second.records.map((record) => record.sequence)).toEqual([5]);
			expect(second.nextAfterSequence).toBeNull();
			expect((await read({ ...DAY, afterSequence: 5 })).count).toBe(4);

			// Moving `until` onto a record leaves it out; one millisecond later
			// takes it in.
			expect(
				(
					await read({ from: DAY.from, until: "2026-11-18T10:00:00Z" })
				).records.map((record) => record.sequence),
			).toEqual([2]);
			expect(
				(
					await read({ from: DAY.from, until: "2026-11-18T10:00:00.001Z" })
				).records.map((record) => record.sequence),
			).toEqual([2, 3]);
			// An offset names the same instant.
			expect(
				(await read({ from: "2026-11-18T01:00:00+01:00", until: DAY.until }))
					.count,
			).toBe(4);
			for (const range of [
				{ from: DAY.until, until: DAY.from },
				{ from: DAY.from, until: DAY.from },
				{ from: "yesterday", until: DAY.until },
				{ ...DAY, limit: 201 },
			])
				await expect(read(range)).rejects.toMatchObject({
					code: "BAD_REQUEST",
				});
		} finally {
			sqlite.close();
		}
	});

	it("filters by resource and actor, in the count as well as the page", async () => {
		const { sqlite, member } = await ledger();
		try {
			const read = member(ORG_A, "owner-a");
			const byResource = await read({ ...DAY, resource: "tool:send_example" });
			expect(byResource.count).toBe(1);
			expect(byResource.records.map((record) => record.sequence)).toEqual([3]);
			const byActor = await read({ ...DAY, actorId: "user-1", limit: 1 });
			expect(byActor.count).toBe(3);
			expect(byActor.records.map((record) => record.sequence)).toEqual([2]);
			expect(byActor.nextAfterSequence).toBe(2);
			const both = await read({
				...DAY,
				resource: "tool:get_example",
				actorId: "user-2",
			});
			expect(both.count).toBe(1);
			expect(both.records.map((record) => record.sequence)).toEqual([4]);
			expect(
				(
					await read({
						...DAY,
						resource: "tool:send_example",
						actorId: "user-2",
					})
				).count,
			).toBe(0);
		} finally {
			sqlite.close();
		}
	});
});

describe("verifying an export offline", () => {
	const NOW = Date.parse("2026-11-19T12:00:00.000Z");
	/** Every approval field, so the seal is shown to cover each one. */
	const lateApproval = {
		approverId: "owner-1",
		approvedAt: "2026-11-18T08:59:00.000Z",
		presentedHash: "a".repeat(64),
		approvalRequestId: "22222222-2222-4222-8222-222222222222",
		kind: "owner_request" as const,
		boundArgsHash: "b".repeat(64),
		singleUse: true,
		policy: {
			revisionId: "revision-1",
			ruleDigest: "c".repeat(64),
			descriptorDigest: "d".repeat(64),
			configHash: "e".repeat(64),
			ruleId: "rule-1",
		},
		reason: "remove the stale record",
	};

	async function sealedLedger() {
		const sqlite = new DatabaseSync(":memory:", {
			enableForeignKeyConstraints: false,
		});
		sqlite.exec(schemaDdl(organizationMembers));
		const store = installOrganizationLogFixture();
		const facade = createD1Facade(sqlite);
		const db = createDbClient(facade);
		await db.insert(organizationMembers).values(
			(
				[
					[ORG_A, "owner-a", "owner"],
					[ORG_A, "member-a", "member"],
					[ORG_B, "owner-b", "owner"],
				] as const
			).map(([organizationId, descopeUserId, role]) => ({
				id: `${organizationId}:${descopeUserId}`,
				organizationId,
				descopeUserId,
				email: `${descopeUserId}@example.test`,
				role,
				status: "active" as const,
			})),
		);
		// Interleaved organizations; each store chains only its own records.
		for (let index = 0; index < 12; index++) {
			const organizationId = index % 3 === 2 ? ORG_B : ORG_A;
			const resource = index % 2 ? "tool:send_example" : "tool:get_example";
			await store.runtime.organizationLogAppend(organizationId, {
				id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				recordedAt: new Date(Date.UTC(2026, 10, 18, 10, index)).toISOString(),
				resource,
				operation: resource.slice("tool:".length),
				actor: { id: "user-1", kind: "user", organizationId },
				source: { surface: "mcp_gateway", traceId: `trace-${index}` },
				decision: {
					verdict: index === 5 ? "deny" : "allow",
					gate: "tool_scope",
					reason: index === 5 ? "refused" : "allowed",
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
				outcome: index === 5 ? "denied" : "applied",
				argsHash: `hash-${index}`,
			} as OrganizationLogAppendInput);
		}
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
			"sign",
			"verify",
		])) as CryptoKeyPair;
		const pkcs8 = encodeBase64(
			new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
		);
		const env = {
			ENVIRONMENT: "test",
			DB: facade,
			CHANGE_RECORD_SIGNING_KEY: pkcs8,
			CHANGE_RECORD_SIGNING_KEY_ID: "change-records-2026",
		};
		// Two seals, so the export spans several checkpoints.
		const signer = {
			privateKey: pair.privateKey,
			keyId: env.CHANGE_RECORD_SIGNING_KEY_ID,
		};
		const sealedAt = new Date(NOW).toISOString();
		await store.seal(ORG_A, sealedAt, signer);
		await store.seal(ORG_B, sealedAt, signer);
		await store.runtime.organizationLogAppend(ORG_A, {
			id: "00000000-0000-4000-8000-000000000099",
			recordedAt: "2026-11-18T09:00:00.000Z",
			resource: "tool:send_example",
			operation: "send_example",
			actor: { id: "user-2", kind: "agent", organizationId: ORG_A },
			source: { surface: "mcp_codemode" },
			decision: {
				verdict: "allow",
				gate: "tool_scope",
				reason: "allowed",
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
			outcome: "applied",
			argsHash: "hash-late",
			approval: lateApproval,
		} as OrganizationLogAppendInput);
		await store.seal(ORG_A, new Date(NOW + 120_000).toISOString(), signer);
		const audit = (organizationId: string, sub: string) =>
			createRouterClient(auditContractRouter, {
				context: {
					db,
					env,
					headers: new Headers(),
					url: new URL("https://api.tedix.test/rpc/audit"),
					authType: "user",
					organizationId,
					user: {
						sub,
						permissions: ["analytics:read"],
						roles: [],
					} as unknown as BaseContext["user"],
				} as unknown as BaseContext,
			});
		/** A stored record, by reference, to tamper with it in the store. */
		const storedBody = (id: string) =>
			store.records(ORG_A).find((record) => record.id === id) as unknown as
				| GatewayChangeRecordBody
				| undefined;
		const remove = (id: string) => {
			const records = store.records(ORG_A);
			records.splice(
				records.findIndex((record) => record.id === id),
				1,
			);
		};
		return { sqlite, audit, publicKey: pair.publicKey, storedBody, remove };
	}

	/** Read every record and checkpoint of the caller's organization. */
	async function exportAll(
		client: ReturnType<Awaited<ReturnType<typeof sealedLedger>>["audit"]>,
	) {
		const records = [];
		let afterSequence: number | undefined;
		do {
			const page = await client.listGatewayChangeRecords({
				from: "2000-01-01T00:00:00Z",
				until: "2100-01-01T00:00:00Z",
				limit: 3,
				afterSequence,
			});
			records.push(...page.records);
			afterSequence = page.nextAfterSequence ?? undefined;
		} while (afterSequence !== undefined);
		const checkpoints = [];
		let afterLastSequence: number | undefined;
		let publicKey = null;
		do {
			const page = await client.listGatewayChangeRecordCheckpoints({
				limit: 1,
				afterLastSequence,
			});
			checkpoints.push(...page.checkpoints);
			publicKey = page.publicKey;
			afterLastSequence = page.nextAfterLastSequence ?? undefined;
		} while (afterLastSequence !== undefined);
		return { records, checkpoints, publicKey };
	}

	it("verifies what the two reads return with only the public key", async () => {
		const { sqlite, audit, publicKey, storedBody, remove } =
			await sealedLedger();
		try {
			const exported = await exportAll(audit(ORG_A, "owner-a"));
			expect(exported.records).toHaveLength(9);
			expect(
				exported.records.every(
					(record) => record.recordDigest && record.chainHash,
				),
			).toBe(true);
			expect(exported.checkpoints.length).toBeGreaterThanOrEqual(2);
			expect(exported.checkpoints[0]?.envelope?.signatures[0]?.keyid).toBe(
				"change-records-2026",
			);
			expect(exported.publicKey).toMatchObject({
				keyId: "change-records-2026",
				algorithm: "Ed25519",
			});

			// The verifier holds the public key from elsewhere; the one the read
			// returns is the same key.
			const fromRead = await importVerifyingKey(exported.publicKey?.spki ?? "");
			expect(await crypto.subtle.exportKey("spki", fromRead)).toEqual(
				await crypto.subtle.exportKey("spki", publicKey),
			);
			const offline = JSON.parse(JSON.stringify(exported));
			expect(
				await verifyChain({
					records: offline.records,
					checkpoints: offline.checkpoints,
					publicKey,
				}),
			).toMatchObject({
				ok: true,
				recordsVerified: 9,
				checkpointsVerified: exported.checkpoints.length,
			});

			// The approval evidence comes back whole and is under the seal.
			const late = exported.records.find(
				(record) => record.id === "00000000-0000-4000-8000-000000000099",
			);
			expect(late?.approval).toEqual(lateApproval);
			const stored = storedBody("00000000-0000-4000-8000-000000000099")!;
			stored.approval = { ...lateApproval, boundArgsHash: "f".repeat(64) };
			const forged = await exportAll(audit(ORG_A, "owner-a"));
			expect(
				await verifyChain({
					records: forged.records,
					checkpoints: forged.checkpoints,
					publicKey,
				}),
			).toMatchObject({
				ok: false,
				reason: "digest",
				sequence: late?.sequence,
			});
			stored.approval = lateApproval;

			// A record deleted from the store shows up in the next export.
			remove("00000000-0000-4000-8000-000000000007");
			const deleted = await exportAll(audit(ORG_A, "owner-a"));
			expect(
				await verifyChain({
					records: deleted.records,
					checkpoints: deleted.checkpoints,
					publicKey,
				}),
			).toMatchObject({ ok: false, reason: "gap", sequence: 7 });

			// So does an edited record, at its own sequence.
			storedBody("00000000-0000-4000-8000-000000000004")!.outcome = "denied";
			const tampered = await exportAll(audit(ORG_A, "owner-a"));
			expect(
				await verifyChain({
					records: tampered.records,
					checkpoints: tampered.checkpoints,
					publicKey,
				}),
			).toMatchObject({ ok: false, reason: "digest", sequence: 4 });
		} finally {
			sqlite.close();
		}
	});

	it("gives checkpoints only to an owner or admin of the organization", async () => {
		const { sqlite, audit } = await sealedLedger();
		try {
			const own = await audit(
				ORG_B,
				"owner-b",
			).listGatewayChangeRecordCheckpoints({});
			expect(own.checkpoints.length).toBeGreaterThan(0);
			expect(
				own.checkpoints.every(
					(checkpoint) => checkpoint.organizationId === ORG_B,
				),
			).toBe(true);
			for (const [organizationId, sub] of [
				[ORG_A, "member-a"],
				[ORG_A, "owner-b"],
				[ORG_B, "owner-a"],
			] as const)
				await expect(
					audit(organizationId, sub).listGatewayChangeRecordCheckpoints({}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				audit(ORG_A, "owner-a").listGatewayChangeRecordCheckpoints({
					organizationId: ORG_B,
				} as Record<string, never>),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			// Sequence filters select overlapping checkpoints.
			const all = (
				await audit(ORG_A, "owner-a").listGatewayChangeRecordCheckpoints({})
			).checkpoints;
			const last = all.at(-1);
			const fromLast = await audit(
				ORG_A,
				"owner-a",
			).listGatewayChangeRecordCheckpoints({
				fromSequence: last?.lastSequence,
			});
			expect(fromLast.checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
				last?.id,
			]);
		} finally {
			sqlite.close();
		}
	});
});
