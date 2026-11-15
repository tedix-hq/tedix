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

const { verify, interfaces } = vi.hoisted(() => ({
	verify: vi.fn(),
	interfaces: vi.fn(),
}));
vi.mock("../services/personal-agent-session", () => ({
	verifySignedOutPersonalAgentSession: verify,
}));
vi.mock("../services/personal-agent-interfaces", () => ({
	personalAgentInterfaces: interfaces,
}));

it("requires service auth and audits accepted feedback without the report, URL or Session proof", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(auditEvents));
	const db = createDbClient(createD1Facade(sqlite));
	const input = {
		organizationId: "org-example",
		appId: "app-example",
		method: "POST",
		url: "https://mcp.example/mcp/poppy/feedback?secret=fictional-secret",
		sessionToken: "fictional-secret",
		version: "1.0",
		report: { task: "fictional-secret", description: "fictional-secret" },
	};
	const context = {
		db,
		authType: "none",
		headers: new Headers(),
		env: {} as CloudflareEnv,
		url: new URL("https://api.example/rpc/osTenant/personalAgentInterfaces"),
	} as BaseContext;
	try {
		const client = createRouterClient(osTenantContractRouter, { context });
		await expect(client.personalAgentInterfaces(input)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(interfaces).not.toHaveBeenCalled();
		context.headers.set("X-Service-Binding", "true");
		interfaces.mockResolvedValue({ status: "accepted" });
		await client.personalAgentInterfaces(input);
		for (const status of [
			"invalid_session",
			"invalid_request",
			"unavailable",
			"rate_limited",
		]) {
			interfaces.mockResolvedValue({ status });
			await client.personalAgentInterfaces(input);
		}
		const rows = await getAuditEventsByResource(
			db,
			input.organizationId,
			"app",
			input.appId,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "os.personal_agent_interfaces.received",
			metadata: { sessionType: "signed_out" },
		});
		expect(JSON.stringify(rows)).not.toContain("fictional-secret");
	} finally {
		sqlite.close();
	}
});

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
		const identity = {
			clientId: "https://private-client.example/agent.json",
			userId: "private-user",
			sessionId: "private-session",
			agentId: "private-agent",
			version: "1.0",
		};
		context.headers.delete("X-Service-Binding");
		await expect(client.personalAgentSession(input)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		expect(verify).not.toHaveBeenCalled();
		context.headers.set("X-Service-Binding", "true");
		verify.mockResolvedValue({
			status: "accepted",
			sessionCreated: true,
			identity,
		});
		expect(await client.personalAgentSession(input)).toEqual({
			status: "accepted",
			sessionCreated: true,
			identity,
		});
		verify.mockResolvedValue({ status: "accepted", identity });
		await client.personalAgentSession(input);
		for (const status of [
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
		for (const claim of Object.values(identity)) {
			if (claim !== "1.0") expect(JSON.stringify(rows)).not.toContain(claim);
		}
	} finally {
		sqlite.close();
	}
});
