import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { getAuditEventsByResource } from "@tedix/db/queries/audit";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "./orpc";
import { osTenantContractRouter } from "./routers/os-tenant";

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("../services/personal-agent-session", () => ({
	verifySignedOutPersonalAgentSession: verify,
}));

it("audits a new Session once through the real router without storing request secrets", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	const context = {
		db,
		authType: "none",
		headers: new Headers({
			"X-Service-Binding": "true",
			"Poppy-Session": "fictional-secret",
		}),
		env: {} as CloudflareEnv,
		url: new URL("https://api.example/rpc/osTenant/personalAgentSession"),
	} as BaseContext;
	const client = createRouterClient(osTenantContractRouter, { context });
	const input = {
		organizationId: "org-example",
		appId: "app-example",
		sessionToken: "fictional-secret",
		url: "https://mcp.example/mcp?private=fictional-secret",
		method: "GET",
		version: "1.0",
	};
	try {
		verify.mockResolvedValue({ status: "accepted", sessionCreated: true });
		await client.personalAgentSession(input);
		for (const status of [
			"accepted",
			"not_configured",
			"invalid_session",
			"session_ended",
			"rate_limited",
			"version_unsupported",
		]) {
			verify.mockResolvedValue({ status });
			await client.personalAgentSession(input);
		}
		const rows = await getAuditEventsByResource(
			db,
			input.organizationId,
			"app",
			input.appId,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "os.personal_agent_session.started",
			actorType: "service",
			actorId: "service-binding",
			metadata: { sessionType: "signed_out" },
		});
		expect(JSON.stringify(rows)).not.toContain("fictional-secret");
		expect(JSON.stringify(rows)).not.toContain("private=");
	} finally {
		sqlite.close();
	}
});
