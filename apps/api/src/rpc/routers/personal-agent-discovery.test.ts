import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { OrganizationMetadataSchema } from "@tedix/api-contract/schemas/organization";
import type { BaseContext } from "../orpc";
import { osTenantContractRouter } from "./os-tenant";

let sqlite: DatabaseSync;
const config = {
	domain: "alpha.example.com",
	mcpUrl: "https://mcp.alpha.example.com/mcp",
	description: "Shared tasks and results",
};
function client(service = true) {
	return createRouterClient(osTenantContractRouter, {
		context: {
			authType: "none",
			db: createDbClient(createD1Facade(sqlite)),
			env: { ENVIRONMENT: "test" },
			headers: new Headers(service ? { "X-Service-Binding": "true" } : {}),
			url: new URL("https://api/rpc/osTenant/personalAgentDiscovery"),
		} as BaseContext,
	});
}
const input = { organizationId: "org-alpha", hostname: config.domain };

describe("organization Personal Agent Protocol discovery", () => {
	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(organizations));
		sqlite
			.prepare(
				"INSERT INTO organizations (id,name,slug,features,metadata) VALUES (?,?,?,?,?)",
			)
			.run(
				"org-alpha",
				"Alpha",
				"alpha",
				JSON.stringify({ os: true }),
				JSON.stringify({
					personalAgentProtocol: config,
					contactEmail: "private@example.com",
				}),
			);
	});
	afterEach(() => sqlite.close());
	it("requires a service binding", async () => {
		await expect(
			client(false).personalAgentDiscovery(input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
	it("projects only supported discovery fields from current organization data", async () => {
		const api = client();
		const expected = {
			protocol_version: "1.0",
			organization: { name: "Alpha", domain: config.domain },
			auth: { disabled: true },
			apis: [
				{ type: "mcp", url: config.mcpUrl, description: config.description },
			],
		};
		expect(await api.personalAgentDiscovery(input)).toEqual(expected);
		sqlite.exec("UPDATE organizations SET name='Renamed'");
		expect(await api.personalAgentDiscovery(input)).toEqual({
			...expected,
			organization: { ...expected.organization, name: "Renamed" },
		});
	});
	it("advertises the opt-in tasks endpoint on the listed MCP server", async () => {
		sqlite.prepare("UPDATE organizations SET metadata=?").run(
			JSON.stringify({
				personalAgentProtocol: {
					...config,
					interfaces: { excludedTasks: [], feedback: true },
				},
			}),
		);
		expect(await client().personalAgentDiscovery(input)).toMatchObject({
			tasks: { endpoint: `${config.mcpUrl}/poppy/tasks` },
		});
	});
	it("publishes only the configured Company Agent endpoint and description", async () => {
		const companyAgent = {
			tediId: "00000000-0000-4000-8000-000000000001",
			description: "Public support",
			publicInstructions: "Private configuration must not appear in discovery",
		};
		sqlite
			.prepare("UPDATE organizations SET metadata=?")
			.run(
				JSON.stringify({ personalAgentProtocol: { ...config, companyAgent } }),
			);
		const discovery = await client().personalAgentDiscovery(input);
		expect(discovery?.agent).toEqual({
			protocols: [
				{
					type: "poppy",
					endpoint: `${config.mcpUrl}/poppy/conversations`,
					description: companyAgent.description,
				},
			],
		});
		expect(JSON.stringify(discovery)).not.toContain(
			companyAgent.publicInstructions,
		);
		expect(JSON.stringify(discovery)).not.toContain(companyAgent.tediId);
	});
	it("does not publish another host or an unconfigured organization", async () => {
		expect(
			await client().personalAgentDiscovery({
				...input,
				hostname: "other.example.com",
			}),
		).toBeNull();
		expect(
			await client().personalAgentDiscovery({
				...input,
				organizationId: "missing",
			}),
		).toBeNull();
		sqlite.exec("UPDATE organizations SET metadata='{}'");
		expect(await client().personalAgentDiscovery(input)).toBeNull();
	});
	it.each(['{"os":false}', "null"])(
		"does not publish an unprovisioned organization (%s)",
		async (features) => {
			sqlite.prepare("UPDATE organizations SET features=?").run(features);
			expect(await client().personalAgentDiscovery(input)).toBeNull();
		},
	);
	it("withdraws discovery for offboarding organizations and malformed stored data", async () => {
		for (const metadata of [
			{ cancelledAt: "2026-01-01", personalAgentProtocol: config },
			{
				personalAgentProtocol: { ...config, mcpUrl: "http://example.com/mcp" },
			},
		]) {
			sqlite
				.prepare("UPDATE organizations SET metadata=?")
				.run(JSON.stringify(metadata));
			expect(await client().personalAgentDiscovery(input)).toBeNull();
		}
	});
	it.each([
		"http://example.com/mcp",
		"https://user:password@example.com/mcp",
		"https://example.com/mcp#secret",
	])("rejects unsafe published URLs (%s)", (mcpUrl) => {
		expect(
			OrganizationMetadataSchema.safeParse({
				personalAgentProtocol: { ...config, mcpUrl },
			}).success,
		).toBe(false);
	});
});
