/**
 * Machines and their tool calls, through the real middleware and a real
 * database: who may queue and read a call, and which runner may claim one.
 * The tedi context is built from the tedi runtime's real scope list, so a
 * scope dropped on either side fails here.
 */

import { createRouterClient } from "@orpc/server";
import { hashValue } from "@tedix/agent-governance/hash";
import {
	MACHINES_USE_SCOPE,
	MACHINES_WRITE_SCOPE,
} from "@tedix/api-contract/schemas/machines";
import { createDbClient } from "@tedix/db/client";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import {
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import { GatewayChangeRecordSchema } from "@tedix/api-contract/schemas/audit";
import { gatewayChangeRecords } from "@tedix/db/schema/gateway-change-records";
import { machineToolCalls, machineToolPolls } from "@tedix/db/schema/machines";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { organizations } from "@tedix/db/schema/organizations";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../tedi-runtime/src/platform-client-factory";
import { writeMachineToolResultRecords } from "../../services/machine-change-records";
import { MachineConnectionDO } from "../../services/machine-connection-do";
import { verifyMachineConnectionTicket } from "../../services/machine-connections";
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
			machineToolPolls,
			gatewayChangeRecords,
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
	/** The change ledger's rows, each checked against the published record schema. */
	const records = () =>
		(
			sqlite
				.prepare(
					"SELECT id, sequence, recorded_at, organization_id, record FROM gateway_change_records ORDER BY sequence",
				)
				.all() as {
				id: string;
				sequence: number;
				recorded_at: string;
				organization_id: string;
				record: string;
			}[]
		).map((row) => ({
			organizationId: row.organization_id,
			raw: row.record,
			...GatewayChangeRecordSchema.parse({
				...JSON.parse(row.record),
				id: row.id,
				sequence: row.sequence,
				recordedAt: row.recorded_at,
			}),
		}));
	return {
		sqlite,
		db: base.db,
		env: base.env,
		person,
		runtime,
		report,
		records,
	};
}

const claim = { reporterId: "reporter-1", machineName: "Studio", limit: 5 };

describe("machines", () => {
	it("lists the machines of the caller's organization only", async () => {
		const f = fixture();
		const member = f.person("member-subject");
		await f.report(member, { cliVersion: "0.24.0" });
		await f.report(member, { cliVersion: "0.24.1" });
		await f.report(f.person("outsider-subject", OTHER_ORG), {
			machineName: "Elsewhere",
		});

		const expected = [
			expect.objectContaining({
				machineName: "Studio",
				executors: ["codex"],
				cliVersion: "0.24.1",
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

	it("pushes a call over the machine's open connection and stores the answer sent back on it", async () => {
		const f = fixture();
		const sockets: {
			sent: string[];
			send(text: string): void;
			deserializeAttachment(): unknown;
		}[] = [];
		const connection = new MachineConnectionDO(
			{
				getWebSockets: () => sockets,
				getWebSocketAutoResponseTimestamp: () => null,
			} as never,
			f.env,
		);
		const env = {
			...f.env,
			MACHINE_CONNECTIONS: { getByName: () => connection },
			PLATFORM_SERVICE_TOKEN: "test-signing-secret",
			API_URL: "https://api.tedix.test",
		} as unknown as CloudflareEnv;
		const member = f.person("member-subject", ORG, { env });
		await f.report(member);

		// The claim that proves who the machine is returns the ticket for it.
		const claimed = await member.machines.claimToolCalls(claim);
		expect(claimed.connection?.url).toBe(
			"wss://api.tedix.test/machines/connect",
		);
		const identity = await verifyMachineConnectionTicket(
			env,
			claimed.connection!.ticket,
		);
		expect(identity).toEqual({
			orgId: ORG,
			machineName: "Studio",
			reporterId: "reporter-1",
		});
		const socket = {
			sent: [] as string[],
			send(text: string) {
				this.sent.push(text);
			},
			deserializeAttachment: () => ({ ...identity, openedAt: Date.now() }),
		};
		sockets.push(socket);

		const { callId } = await f
			.person("second-subject", ORG, { env })
			.machines.requestToolCall({
				machine: "Studio",
				tool: "read_file",
				input: { path: "README.md" },
			});
		expect(socket.sent.map((text) => JSON.parse(text))).toEqual([
			{ callId, tool: "read_file", input: { path: "README.md" } },
		]);

		await connection.webSocketMessage(
			socket as never,
			JSON.stringify({ callId, ok: true, result: "# Example" }),
		);
		expect(JSON.parse(socket.sent[1]!)).toEqual({ answered: callId });
		expect(
			await f
				.person("second-subject", ORG, { env })
				.machines.readToolCall({ callId }),
		).toMatchObject({ status: "done", result: "# Example" });
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

	it("queues a write tool only for a machine that accepts it, and for a tedi only with the write scope", async () => {
		const f = fixture();
		const input = {
			machine: "Studio",
			tool: "run_command" as const,
			input: { workspace: "fix-0a1b2c3d", command: "bun test" },
		};
		// The machine's owner has not switched the write tools on.
		await f.report(f.person("member-subject"));
		await expect(
			f.runtime("tedi-1").machines.requestToolCall(input),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		await f.report(f.person("member-subject"), {
			machineTools: ["read_file", "run_command"],
		});
		expect(
			await f.runtime("tedi-1").machines.requestToolCall(input),
		).toMatchObject({ status: "pending" });
		await expect(
			f
				.runtime(
					"tedi-1",
					TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
						(scope) => scope !== MACHINES_WRITE_SCOPE,
					),
				)
				.machines.requestToolCall(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
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

describe("machine change records", () => {
	// Text that must never reach the ledger: command, file content, output.
	const SECRET = "sentinel-7f3a-do-not-store";
	const writeTools = { machineTools: ["read_file", "run_command"] };
	const command = {
		machine: "Studio",
		tool: "run_command" as const,
		input: { workspace: "fix-0a1b2c3d", command: `echo ${SECRET}` },
	};

	it("records a tedi's write call when queued and when its result is stored, never a read", async () => {
		const f = fixture();
		const runner = f.person("member-subject");
		await f.report(runner, writeTools);
		await f.runtime("tedi-1").machines.requestToolCall({
			machine: "Studio",
			tool: "read_file",
			input: { path: "README.md" },
		});
		expect(f.records()).toEqual([]);

		const { callId } = await f
			.runtime("tedi-1")
			.machines.requestToolCall(command);
		expect(f.records()).toEqual([
			expect.objectContaining({
				organizationId: ORG,
				resource: "machine:Studio",
				operation: "run_command",
				actor: { id: "tedi-1", kind: "tedi", organizationId: ORG },
				source: { surface: "api", traceId: callId },
				decision: expect.objectContaining({
					verdict: "allow",
					reason: "queued",
					riskTier: "high_impact_write",
				}),
				outcome: "unknown",
			}),
		]);

		await runner.machines.claimToolCalls(claim);
		// Another runner of the same account never claimed the call.
		await f.report(runner, { ...writeTools, reporterId: "reporter-2" });
		const result = { callId, ok: true, result: `${SECRET} done` };
		await runner.machines.claimToolCalls({
			...claim,
			reporterId: "reporter-2",
			results: [result],
		});
		expect(f.records()).toHaveLength(1);
		await runner.machines.claimToolCalls({ ...claim, results: [result] });
		// A repeated result is not stored again, so it is not recorded again.
		await runner.machines.claimToolCalls({ ...claim, results: [result] });
		const records = f.records();
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({
			resource: "machine:Studio",
			operation: "run_command",
			actor: { id: "tedi-1", kind: "tedi" },
			source: { traceId: callId },
			decision: { reason: "result_stored reporter:reporter-1" },
			outcome: "applied",
		});
		for (const record of records) expect(record.raw).not.toContain(SECRET);

		// Record ids come from the call id, so writing the same one again
		// (a retried request) stores no second row.
		await writeMachineToolResultRecords(f.db, {
			orgId: ORG,
			reporterId: "reporter-1",
			calls: [
				{
					id: callId,
					machineName: "Studio",
					tool: "run_command",
					requestedByType: "tedi",
					requestedById: "tedi-1",
					status: "done",
					result: "x",
					error: null,
				},
			],
		});
		expect(f.records()).toHaveLength(2);
	});

	it("records a refusal once the requester is known, for read tools too", async () => {
		const f = fixture();
		const member = f.person("member-subject");
		await f.report(member, writeTools);
		await expect(
			f
				.runtime(
					"tedi-1",
					TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
						(scope) => scope !== MACHINES_WRITE_SCOPE,
					),
				)
				.machines.requestToolCall(command),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			member.machines.requestToolCall({ ...command, machine: "Nowhere" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			member.machines.requestToolCall({
				machine: "Studio",
				tool: "read_file",
				input: { path: "a", command: SECRET },
			} as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		// A requester that cannot be identified leaves no record.
		await expect(
			f
				.runtime(
					"tedi-1",
					TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
						(scope) => scope !== MACHINES_USE_SCOPE,
					),
				)
				.machines.requestToolCall(command),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const records = f.records();
		expect(
			records.map((record) => [
				record.actor.id,
				record.resource,
				record.decision.reason,
				record.outcome,
			]),
		).toEqual([
			["tedi-1", "machine:Studio", "write_scope_missing", "denied"],
			["member", "machine:Nowhere", "unknown_machine", "denied"],
			["member", "machine:Studio", "invalid_input", "denied"],
		]);
		for (const record of records) expect(record.raw).not.toContain(SECRET);
	});

	it("queues nothing when the queued record cannot be written", async () => {
		const f = fixture();
		const runner = f.person("member-subject");
		await f.report(runner, writeTools);
		f.sqlite.exec("DROP TABLE gateway_change_records");
		await expect(
			f.runtime("tedi-1").machines.requestToolCall(command),
		).rejects.toThrow();
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM machine_tool_calls").get(),
		).toEqual({ n: 0 });
		expect((await runner.machines.claimToolCalls(claim)).calls).toEqual([]);
	});
});

describe("listing machine tool calls", () => {
	const SECRET = "sentinel-91c4-result-text";
	const writeTools = { machineTools: ["read_file", "run_command"] };
	const command = {
		machine: "Studio",
		tool: "run_command" as const,
		input: { workspace: "fix-0a1b2c3d", command: "bun test" },
	};

	it("lists calls with their input to an owner or admin only, never the result", async () => {
		const f = fixture();
		f.sqlite.exec(
			`INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m5','${ORG}','admin-subject','admin','admin@example.test','admin','active')`,
		);
		const runner = f.person("member-subject");
		await f.report(runner, writeTools);
		const { callId } = await f
			.runtime("tedi-1")
			.machines.requestToolCall(command);
		await runner.machines.requestToolCall({
			machine: "Studio",
			tool: "read_file",
			input: { path: "README.md" },
		});
		await runner.machines.claimToolCalls(claim);
		await runner.machines.claimToolCalls({
			...claim,
			results: [{ callId, ok: true, result: `${SECRET} passed` }],
		});

		for (const subject of ["owner-subject", "admin-subject"]) {
			const listed = await f.person(subject).machines.listToolCalls({});
			expect(listed.calls).toEqual([
				expect.objectContaining({
					callId,
					machine: "Studio",
					tool: "run_command",
					input: command.input,
					status: "done",
					requestedBy: { type: "tedi", id: "tedi-1" },
					resultChars: `${SECRET} passed`.length,
				}),
			]);
			expect(listed.nextCursor).toBeNull();
			expect(JSON.stringify(listed)).not.toContain(SECRET);
		}
		const all = await f
			.person("owner-subject")
			.machines.listToolCalls({ writesOnly: false, machine: "Studio" });
		expect(all.calls.map((call) => call.tool).sort()).toEqual([
			"read_file",
			"run_command",
		]);
		expect(JSON.stringify(all)).not.toContain(SECRET);

		for (const client of [
			f.person("member-subject"),
			f.person("owner-subject", ORG, { externalAgentPrincipalId: AGENT }),
			f.runtime("tedi-1"),
		])
			await expect(client.machines.listToolCalls({})).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		// Another organization's owner sees only their own, empty, list.
		expect(
			(
				await f
					.person("outsider-subject", OTHER_ORG)
					.machines.listToolCalls({ writesOnly: false })
			).calls,
		).toEqual([]);
		// A range longer than 7 days is refused rather than scanned.
		await expect(
			f.person("owner-subject").machines.listToolCalls({
				from: "2026-11-01T00:00:00.000Z",
				until: "2026-11-09T00:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("pages through every call exactly once, ties included", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"), writeTools);
		const queued = [];
		for (let i = 0; i < 5; i++)
			queued.push(
				(await f.runtime("tedi-1").machines.requestToolCall(command)).callId,
			);
		// Three calls share one instant, so the cursor must break ties by id.
		f.sqlite.exec(
			`UPDATE machine_tool_calls SET created_at = '${new Date(Date.now() - 60_000).toISOString()}' WHERE id IN ('${queued.slice(0, 3).join("','")}')`,
		);
		const owner = f.person("owner-subject");
		const seen: string[] = [];
		let cursor: { at: string; id: string } | undefined;
		for (let page = 0; page < 5; page++) {
			const listed = await owner.machines.listToolCalls({ limit: 2, cursor });
			seen.push(...listed.calls.map((call) => call.callId));
			if (!listed.nextCursor) break;
			cursor = listed.nextCursor;
		}
		expect(seen).toHaveLength(5);
		expect([...seen].sort()).toEqual([...queued].sort());
	});

	it("returns an input whose hash is the argsHash of the call's queued record", async () => {
		const f = fixture();
		await f.report(f.person("member-subject"), writeTools);
		const { callId } = await f
			.runtime("tedi-1")
			.machines.requestToolCall(command);
		const [call] = (await f.person("owner-subject").machines.listToolCalls({}))
			.calls;
		const queued = f
			.records()
			.find(
				(record) =>
					record.source.traceId === callId &&
					record.decision.reason === "queued",
			);
		expect(queued).toBeDefined();
		expect(await hashValue(call?.input)).toBe(queued?.argsHash);
	});
});
