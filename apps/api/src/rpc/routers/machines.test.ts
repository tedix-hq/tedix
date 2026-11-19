/**
 * Machines and their tool calls, through the real middleware and a real
 * database: who may queue and read a call, and which runner may claim one.
 * The tedi context is built from the tedi runtime's real scope list, so a
 * scope dropped on either side fails here.
 */

import { createRouterClient } from "@orpc/server";
import { MACHINES_USE_SCOPE } from "@tedix/api-contract/schemas/machines";
import { createDbClient } from "@tedix/db/client";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import { machineToolCalls } from "@tedix/db/schema/machines";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../tedi-runtime/src/platform-client-factory";
import type { BaseContext } from "../orpc";
import { dispatcherHealthContractRouter } from "./dispatcher-health";
import { machinesContractRouter } from "./machines";

const ORG = "00000000-0000-4000-8000-000000000401";
const OTHER_ORG = "00000000-0000-4000-8000-000000000402";
const AGENT = "00000000-0000-4000-8000-000000000403";
const AGENT_SESSION = "00000000-0000-4000-8000-000000000404";
const router = {
	machines: machinesContractRouter,
	health: dispatcherHealthContractRouter,
};

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			organizations,
			organizationMembers,
			tedis,
			externalAgentPrincipals,
			externalAgentSessions,
			dispatcherHealthReports,
			machineToolCalls,
		),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${ORG}','Example','example'),('${OTHER_ORG}','Other','other');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES
			('m1','${ORG}','owner-subject','owner','owner@example.test','owner','active'),
			('m2','${ORG}','member-subject','member','member@example.test','member','active'),
			('m3','${ORG}','second-subject','second','second@example.test','member','active'),
			('m4','${OTHER_ORG}','outsider-subject','outsider','outsider@example.test','owner','active');
		INSERT INTO tedis(id,organization_id,name,slug,status,mcp_capability_profile) VALUES
			('tedi-1','${ORG}','Lead','lead','active','standard'),
			('tedi-2','${ORG}','Other','other','active','standard');
		INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id,created_at,updated_at) VALUES
			('${AGENT}','${ORG}','codex-local','Codex','owner_user','member','user','member','2026-11-19','2026-11-19');
		INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,credit_eligible,started_at,last_seen_at) VALUES
			('${AGENT_SESSION}','${ORG}','${AGENT}','codex:one','codex','1','p','m','1','explicit',0,'2026-11-19','2026-11-19');`);
	const facade = createD1Facade(sqlite);
	const base = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/machines"),
	};
	const person = (
		sub: string,
		organizationId = ORG,
		extra: Partial<BaseContext> = {},
	) =>
		createRouterClient(router, {
			context: {
				...base,
				headers: new Headers(),
				organizationId,
				authType: "user",
				user: {
					sub,
					permissions: ["tedis:read", "tedis:update"],
					roles: [],
				},
				...extra,
			} as BaseContext,
		});
	/** Exactly what the tedi runtime sends over its service binding. */
	const runtime = (
		tediId: string,
		scopes: readonly string[] = TEDI_RUNTIME_SERVICE_BINDING_SCOPES,
		headers: Record<string, string> = {},
	) =>
		createRouterClient(router, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": ORG,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Caller": "brain-bridge",
					"X-Tedix-Caller-Source": "http-platform-client",
					"X-Tedix-Tedi-Scopes": scopes.join(" "),
					...headers,
				}),
			} as BaseContext,
		});
	const report = (
		client: ReturnType<typeof person>,
		overrides: Record<string, unknown> = {},
	) =>
		client.health.report({
			reporterId: "reporter-1",
			executor: "codex",
			lane: "codex",
			running: true,
			observedAt: new Date().toISOString(),
			lastAdmissionAt: null,
			topReason: null,
			machineName: "Studio",
			machineTools: ["read_file", "read_runner_state"],
			...overrides,
		});
	return { sqlite, person, runtime, report };
}

const claim = { reporterId: "reporter-1", machineName: "Studio", limit: 5 };

describe("machines", () => {
	it("lists the machines of the caller's organization only", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"));
		await f.report(f.person("outsider-subject", OTHER_ORG), {
			machineName: "Elsewhere",
		});

		const expected = [
			expect.objectContaining({
				machineName: "Studio",
				executors: ["codex"],
				cliVersion: null,
				machineTools: ["read_file", "read_runner_state"],
				online: true,
			}),
		];
		expect((await f.person("second-subject").machines.list()).machines).toEqual(
			expected,
		);
		expect((await f.runtime("tedi-1").machines.list()).machines).toEqual(
			expected,
		);
		await expect(
			f
				.runtime(
					"tedi-1",
					TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
						(scope) => scope !== MACHINES_USE_SCOPE,
					),
				)
				.machines.list(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("queues a call only for a known, online machine and a tool it accepts", async () => {
		const f = fixture();
		const member = f.person("member-subject");
		await f.report(member);
		const request = (input: Record<string, unknown>) =>
			member.machines.requestToolCall({
				machine: "studio",
				tool: "read_file",
				input: { path: "README.md" },
				...input,
			} as never);

		// The name matches whatever its case; the stored call uses the reported one.
		const queued = await request({});
		expect(queued.status).toBe("pending");
		expect(
			f.sqlite
				.prepare("SELECT machine_name, input FROM machine_tool_calls")
				.all(),
		).toEqual([{ machine_name: "Studio", input: '{"path":"README.md"}' }]);

		await expect(request({ machine: "Nowhere" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			request({ tool: "search_code", input: { pattern: "x" } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		for (const path of [
			"../secrets",
			"src/../../etc/passwd",
			"/etc/passwd",
			"~/.ssh/id_ed25519",
			"C:\\Users",
			"a\\..\\b",
		])
			await expect(request({ input: { path } })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		await expect(
			request({ input: { path: "a", startLine: 1, endLine: 401 } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			request({ input: { path: "a", command: "rm -rf ." } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		f.sqlite.exec(
			"UPDATE dispatcher_health_reports SET reported_at = '2026-01-01T00:00:00.000Z'",
		);
		await expect(request({})).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("lets a tedi use a machine only through the tedi runtime's machine scope", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"));
		const input = {
			machine: "Studio",
			tool: "read_runner_state" as const,
			input: {},
		};
		const queued = await f.runtime("tedi-1").machines.requestToolCall(input);
		expect(
			await f
				.runtime("tedi-1")
				.machines.readToolCall({ callId: queued.callId }),
		).toMatchObject({
			machine: "Studio",
			tool: "read_runner_state",
			status: "pending",
		});

		const withoutScope = TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
			(scope) => scope !== MACHINES_USE_SCOPE,
		);
		await expect(
			f.runtime("tedi-1", withoutScope).machines.requestToolCall(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		// A tedi calling through the MCP gateway passes the scope middleware for
		// any declared tool; the handler still asks for the runtime's own scope.
		const viaGateway = f.runtime("tedi-1", withoutScope, {
			"X-Tedix-Mcp-Tool-Id": "request_machine_tool",
		});
		await expect(
			viaGateway.machines.requestToolCall(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			viaGateway.machines.readToolCall({ callId: queued.callId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM machine_tool_calls").get(),
		).toEqual({ n: 1 });
	});

	it("shows a call to the one who queued it and to an admin, and to nobody else", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"));
		const { callId } = await f
			.person("member-subject")
			.machines.requestToolCall({
				machine: "Studio",
				tool: "read_runner_state",
				input: {},
			});
		const read = (client: ReturnType<typeof f.person>) =>
			client.machines.readToolCall({ callId });
		expect((await read(f.person("member-subject"))).callId).toBe(callId);
		expect((await read(f.person("owner-subject"))).callId).toBe(callId);
		await expect(read(f.person("second-subject"))).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(read(f.runtime("tedi-1"))).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			read(f.person("outsider-subject", OTHER_ORG)),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("hands calls only to the account that reports the machine's health", async () => {
		const f = fixture();
		const runner = f.person("member-subject");
		await f.report(runner);
		const { callId } = await f.runtime("tedi-1").machines.requestToolCall({
			machine: "Studio",
			tool: "read_file",
			input: { path: "README.md", startLine: 1, endLine: 40 },
		});

		// Another member, an admin, a tedi and another organization's runner all
		// name the right reporter and machine and get nothing.
		for (const client of [
			f.person("second-subject"),
			f.person("owner-subject"),
			f.runtime("tedi-1"),
			f.person("outsider-subject", OTHER_ORG),
		])
			await expect(client.machines.claimToolCalls(claim)).rejects.toMatchObject(
				{ code: "FORBIDDEN" },
			);
		// The right account under a reporter id or machine it never reported.
		await expect(
			runner.machines.claimToolCalls({ ...claim, reporterId: "reporter-2" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			runner.machines.claimToolCalls({ ...claim, machineName: "Laptop" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect((await runner.machines.claimToolCalls(claim)).calls).toEqual([
			{
				callId,
				tool: "read_file",
				input: { path: "README.md", startLine: 1, endLine: 40 },
			},
		]);
		expect(
			(
				await runner.machines.claimToolCalls({
					...claim,
					results: [{ callId, ok: true, result: "# Tedix" }],
				})
			).calls,
		).toEqual([]);
		expect(
			await f.runtime("tedi-1").machines.readToolCall({ callId }),
		).toMatchObject({ status: "done", result: "# Tedix" });
	});

	it("treats an agent session of the reporting person as that person", async () => {
		const f = fixture();
		// The supervisor reports health with the person's sign-in; the runner
		// claims under that person's own agent session.
		await f.report(f.person("member-subject"));
		const session = f.person("member-subject", ORG, {
			ownerHostSessionId: AGENT_SESSION,
		});
		expect((await session.machines.claimToolCalls(claim)).calls).toEqual([]);
		// And the other way round: health sent under the session, claim without.
		await f.report(session, { reporterId: "reporter-3" });
		expect(
			(
				await f
					.person("member-subject")
					.machines.claimToolCalls({ ...claim, reporterId: "reporter-3" })
			).calls,
		).toEqual([]);
	});

	it("keeps a health report without a machine name out of the machine list", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"), {
			machineName: undefined,
			machineTools: undefined,
		});
		expect((await f.person("member-subject").machines.list()).machines).toEqual(
			[],
		);
		expect(
			f.sqlite
				.prepare("SELECT reported_by FROM dispatcher_health_reports")
				.get(),
		).toEqual({ reported_by: null });
	});
});
