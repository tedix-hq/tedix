import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { gatewayChangeRecords } from "@tedix/db/schema/gateway-change-records";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { auditContractRouter } from "./audit";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

it("stores gateway change records under the gateway's organization only", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		// Only the ledger table exists: an append or list that looked anything
		// else up would fail here.
		sqlite.exec(schemaDdl(gatewayChangeRecords));
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
		const stored = sqlite
			.prepare("SELECT organization_id, record FROM gateway_change_records")
			.all();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.organization_id).toBe(ORG_A);
		expect(Object.keys(JSON.parse(String(stored[0]?.record)))).not.toContain(
			"id",
		);
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

		const other = client(ORG_B);
		await expect(other.appendChangeRecord(namedInput)).rejects.toThrow();
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
