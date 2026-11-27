import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import type { PoppyDoorRequest } from "@tedix/api-contract/schemas/audit";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { auditMetadataRefs } from "@tedix/db/schema/audit-metadata-refs";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { auditContractRouter } from "./audit";

it("records only gateway traffic and reads a bounded, private-field-free feed for the caller's organization and app", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents, auditMetadataRefs));
	const db = createDbClient(createD1Facade(sqlite));
	const context = (organizationId: string): BaseContext => ({
		db,
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.example/rpc/audit"),
		authType: "user",
		user: {
			sub: "reader",
			permissions: ["analytics:read"],
			roles: [],
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.example",
		},
	});
	const reader = (org: string) =>
		createRouterClient(auditContractRouter, { context: context(org) });
	const gatewayContext = (org: string): BaseContext => ({
		...context(org),
		user: undefined,
		authType: undefined,
		serviceBindingPrincipal: "mcp-edge",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": org,
		}),
	});
	const row: PoppyDoorRequest & { appId: string } = {
		appId: "app-a",
		time: "2026-11-27T10:00:00.000Z",
		client_id: "https://agent.example/agent.json",
		method: "tools/list",
		tool: null,
		refused: null,
		outcome: "success",
		httpStatus: 200,
	};
	try {
		const gateway = createRouterClient(auditContractRouter, {
			context: gatewayContext("org-a"),
		});
		await gateway.recordPoppyDoorRequest(row);
		await gateway.recordPoppyDoorRequest({
			...row,
			time: "2026-11-27T10:00:00.900Z",
			client_id: "unidentified",
			refused: "invalid_session",
			outcome: "refused",
			httpStatus: 400,
		});
		await gateway.recordPoppyDoorRequest({ ...row, appId: "app-b" });
		await createRouterClient(auditContractRouter, {
			context: gatewayContext("org-b"),
		}).recordPoppyDoorRequest(row);
		const feed = await reader("org-a").listPoppyDoorRequests({
			appId: "app-a",
			limit: 1,
		});
		expect(feed.requests).toEqual([
			{
				time: "2026-11-27T10:00:00.900Z",
				client_id: "unidentified",
				method: "tools/list",
				tool: null,
				refused: "invalid_session",
				outcome: "refused",
				httpStatus: 400,
			},
		]);
		expect(
			(await reader("org-a").listPoppyDoorRequests({ appId: "app-a" }))
				.requests,
		).toHaveLength(2);
		expect(
			(await reader("org-b").listPoppyDoorRequests({ appId: "app-a" }))
				.requests,
		).toHaveLength(1);
		expect(
			(await reader("org-c").listPoppyDoorRequests({ appId: "app-a" }))
				.requests,
		).toEqual([]);
		// Legacy or accidentally enriched metadata must still never escape this read.
		await db.update(auditEvents).set({
			metadata: {
				...row,
				token: "private-token",
				sid: "private-session",
				userId: "private-person",
				args: { secret: "private-key" },
			},
		});
		const safe = await reader("org-a").listPoppyDoorRequests({
			appId: "app-a",
		});
		expect(Object.keys(safe.requests[0]!).sort()).toEqual([
			"client_id",
			"httpStatus",
			"method",
			"outcome",
			"refused",
			"time",
			"tool",
		]);
		expect(JSON.stringify(safe)).not.toContain("private-");
		await expect(
			gateway.recordPoppyDoorRequest({
				...row,
				token: "private-token",
			} as typeof row),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const unprivileged = context("org-a");
		unprivileged.user!.permissions = [];
		await expect(
			createRouterClient(auditContractRouter, {
				context: unprivileged,
			}).listPoppyDoorRequests({ appId: "app-a" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		for (const headers of [
			{ "X-Tedix-Mcp-Tool-Id": "forged" },
			{ "X-Tedix-Caller-Type": "mcp-edge-user" },
		]) {
			const forged = gatewayContext("org-a");
			for (const [key, value] of Object.entries(headers))
				forged.headers.set(key, value);
			await expect(
				createRouterClient(auditContractRouter, {
					context: forged,
				}).recordPoppyDoorRequest(row),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		const otherService = gatewayContext("org-a");
		otherService.serviceBindingPrincipal = undefined;
		await expect(
			createRouterClient(auditContractRouter, {
				context: otherService,
			}).recordPoppyDoorRequest(row),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	} finally {
		sqlite.close();
	}
});
