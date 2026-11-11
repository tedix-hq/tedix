import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import {
	osGadgetCode,
	osGadgetCodeBlobs,
} from "@tedix/db/schema/os-workspaces";
import { tableDdl } from "@tedix/db/test/schema-ddl";

const gadgetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const namespace = (
	env as unknown as {
		WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
	}
).WORKSPACE_APP_HOST;
const hostWorkspaces = new WeakMap<object, string>();
function createHost() {
	const id = crypto.randomUUID();
	const stub = namespace.getByName(`fictional-org:${id}`);
	hostWorkspaces.set(stub, id);
	return stub;
}
const files = (version: string) => ({
	"client.js": "",
	"server.js": `
import { DurableObject } from 'cloudflare:workers';
let retained;
let retainedCaller;
export class App extends DurableObject {
  caller() { return this.env.CALLER; }
  freezeCaller() {
    const c = this.env.CALLER;
    let refused = 0;
    for (const change of [() => { c.role = 'owner'; }, () => { c.principal.id = 'forged'; }, () => { this.env.CALLER = {}; }, ...(c.guest ? [() => { c.guest.name = 'forged'; }] : [])]) {
      try { change(); } catch { refused++; }
    }
    return { caller: this.env.CALLER, refused };
  }
  rememberCaller() { retainedCaller = this.env.CALLER; return retainedCaller; }
  compareCaller() { return { previous: retainedCaller, current: this.env.CALLER, same: retainedCaller === this.env.CALLER }; }
  feedback(value) {
    if (!value || typeof value.text !== 'string' || Object.keys(value).some(k => k !== 'text')) throw new Error('Invalid feedback');
    this.ctx.storage.kv.put('feedback', { text: value.text, caller: this.env.CALLER });
    return this.ctx.storage.kv.get('feedback');
  }
  recover() { if (!['owner', 'build'].includes(this.env.CALLER.role)) throw new Error('Builder required'); this.ctx.storage.kv.delete('feedback'); return true; }
  async hold() { console.info('fixture_hold_trace', 'queue_hold_started'); await new Promise(resolve => setTimeout(resolve, 5000)); return true; }
  count() { const n = (this.ctx.storage.kv.get('n') || 0) + 1; this.ctx.storage.kv.put('n', n); return {n, version: '${version}'}; }
  log(value) { console.info('fixture_hold_trace', value); console.warn('warning', value); return value; }
  async logWhileRunning() { console.info('fixture_hold_trace', 'still running'); await new Promise(resolve => setTimeout(resolve, 5000)); return 'finished'; }
  readHost() { return this.ctx.storage.kv.get('hostSecret') ?? null; }
  async network() { try { await fetch('https://example.com'); return 'escaped'; } catch { return 'blocked'; } }
  async importEnv() { try { const { env } = await import('cloudflare:workers'); return env.SECRETS_MASTER_KEY || env.LOADER || env.API_SERVICE || env.TEDIX ? 'escaped' : 'blocked'; } catch { return 'blocked'; } }
  async build() { return await this.env.TEDIX.outputsWrite('sheet', {}); }
  remember() { retained = this.env.TEDIX.dup(); return true; }
  async reuse() { try { return await retained.outputsWrite('sheet', {}); } finally { retained[Symbol.dispose](); retained = null; } }
}`,
});
async function call(
	stub: DurableObjectStub<WorkspaceAppHostDO>,
	options: {
		gadget?: string;
		revision?: string;
		version?: string;
		method?: string;
		callId?: string;
		args?: unknown[];
		role?: "build" | "use" | "viewer";
		actorUserId?: string;
		guestName?: string;
		previewId?: string;
		principal?: string;
		principalKind?: string;
		token?: string;
	} = {},
) {
	const code = files(options.version ?? "v1");
	const token = options.token ?? (await mint(stub, code, options)).token;
	return stub.call({
		callId: options.callId,
		session: token,
		files: code,
		method: options.method ?? "count",
		args: options.args ?? [],
	});
}
async function mint(
	stub: DurableObjectStub<WorkspaceAppHostDO>,
	code: Record<string, string>,
	options: Parameters<typeof call>[1] = {},
) {
	return mintWorkspaceAppSession("fictional-app-test-key", {
		organizationId: "fictional-org",
		workspaceId: hostWorkspaces.get(stub)!,
		gadgetId: options.gadget ?? gadgetId,
		revisionId: options.revision ?? revisionId,
		revision: options.revision ? 2 : 1,
		role: options.role ?? "use",
		principal: {
			kind: options.principalKind ?? "user",
			id: options.principal ?? "fictional-member",
		},
		grants: [{ slot: "sheet", operations: ["outputs.read", "outputs.write"] }],
		previewId: options.previewId,
		actorUserId: options.actorUserId,
		guestName: options.guestName,
		codeDigest: await appRuntimeCodeDigest(code),
	});
}
describe("workspace app supervisor in workerd", () => {
	it.each([
		{
			principalKind: "user",
			principal: "member",
			actorUserId: "member",
			role: "build" as const,
		},
		{
			principalKind: "external_agent",
			principal: "agent",
			actorUserId: "owner",
			role: "use" as const,
		},
		{
			principalKind: "app_trigger",
			principal: gadgetId + ":morning",
			actorUserId: "author",
			role: "build" as const,
		},
		{
			principalKind: "share_session",
			principal: "guest-session",
			guestName: "Maya",
			role: "use" as const,
		},
	])(
		"derives immutable caller context from the signed $principalKind session",
		async (options) => {
			const stub = createHost();
			const expected = {
				principal: { kind: options.principalKind, id: options.principal },
				...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
				organizationId: "fictional-org",
				workspaceId: hostWorkspaces.get(stub),
				gadgetId,
				role: options.role,
				preview: false,
				...(options.guestName
					? { guest: { name: options.guestName, selfReported: true } }
					: {}),
			};
			const token = (await mint(stub, files("v1"), options)).token;
			const forged = {
				principal: { kind: "user", id: "owner" },
				role: "owner",
				actorUserId: "owner",
				CALLER: { role: "owner" },
			};
			expect(
				await call(stub, {
					...options,
					token,
					method: "caller",
					args: [forged],
				}),
			).toEqual(expected);
			expect(
				await call(stub, { ...options, token, method: "freezeCaller" }),
			).toEqual({ caller: expected, refused: options.guestName ? 4 : 3 });
			expect(
				await call(stub, { ...options, method: "rememberCaller" }),
			).toEqual(expected);
			expect(
				await call(stub, { method: "compareCaller", principal: "next" }),
			).toMatchObject({
				previous: expected,
				current: { principal: { id: "next" }, role: "use" },
				same: false,
			});
		},
	);
	it("labels previews and sibling apps without sharing caller state", async () => {
		const stub = createHost();
		expect(
			await call(stub, { method: "caller", previewId: crypto.randomUUID() }),
		).toMatchObject({ preview: true, gadgetId });
		const other = crypto.randomUUID();
		expect(
			await call(stub, { method: "caller", gadget: other, principal: "other" }),
		).toMatchObject({
			preview: false,
			gadgetId: other,
			principal: { id: "other" },
		});
		expect(await call(stub, { method: "caller" })).toMatchObject({
			preview: false,
			gadgetId,
			principal: { id: "fictional-member" },
		});
	});
	it("validates feedback and separates ordinary writes from recovery using trusted context", async () => {
		const stub = createHost();
		await expect(
			call(stub, {
				method: "feedback",
				args: [{ text: "hello", actorUserId: "owner" }],
			}),
		).rejects.toThrow("Invalid feedback");
		expect(
			await call(stub, { method: "feedback", args: [{ text: "hello" }] }),
		).toMatchObject({
			text: "hello",
			caller: { role: "use", principal: { id: "fictional-member" } },
		});
		await expect(
			call(stub, { method: "recover", args: [{ role: "build" }] }),
		).rejects.toThrow("Builder required");
		expect(await call(stub, { method: "recover", role: "build" })).toBe(true);
	});
	it("rejects a queued revoked author before any app-local mutation", async () => {
		const stub = createHost();
		await call(stub);
		const token = (
			await mint(stub, files("v1"), {
				principalKind: "app_trigger",
				actorUserId: "author",
			})
		).token;
		const callId = crypto.randomUUID();
		const holding = call(stub, { method: "hold", callId }).catch(
			() => undefined,
		);
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, async (_instance, state) => {
					const traces = await state.storage.list({ prefix: "app-tail:" });
					return [...traces.values()].some((trace) =>
						JSON.stringify(trace).includes("queue_hold_started"),
					);
				}),
			).toBe(true),
		);
		const queued = call(stub, { token }).then(
			() => "ran",
			() => "denied",
		);
		await stub.revokeSessions({
			organizationId: "fictional-org",
			workspaceId: hostWorkspaces.get(stub)!,
			principalIds: ["author"],
			at: Math.floor(Date.now() / 1000),
		});
		await holding;
		expect(await queued).toBe("denied");
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});
	it("correlates actual console tails for queued and sibling app calls", async () => {
		const stub = createHost();
		const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
		await Promise.all(
			ids.map((callId, index) =>
				call(stub, {
					callId,
					method: "log",
					args: [String(index)],
					...(index === 2
						? { gadget: "44444444-4444-4444-8444-444444444444" }
						: {}),
				}),
			),
		);
		await vi.waitFor(async () => {
			const pending = await runInDurableObject(
				stub,
				async (_instance, state) => [
					...(
						await state.storage.list<{
							callId?: string;
							events: Array<{
								logs: Array<{ level: string; message: string }>;
							}>;
						}>({
							prefix: "app-tail:",
						})
					).values(),
				],
			);
			expect(
				[
					...new Set(
						pending
							.filter((trace) => trace.callId)
							.map((trace) => trace.callId),
					),
				].sort(),
			).toEqual(ids.slice().sort());
			for (const [index, id] of ids.entries()) {
				const traces = pending.filter((item) => item.callId === id);
				expect(
					traces.flatMap((trace) =>
						trace.events.flatMap((event) => event.logs),
					),
				).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							level: "info",
							message: JSON.stringify(["fixture_hold_trace", String(index)]),
						}),
						expect.objectContaining({
							level: "warn",
							message: JSON.stringify(["warning", String(index)]),
						}),
					]),
				);
				expect(JSON.stringify(traces)).not.toContain("__tedix_app_trace__");
			}
		});
	});
	it("persists a console line before the app call completes", async () => {
		const stub = createHost();
		const callId = crypto.randomUUID();
		let finished = false;
		const running = call(stub, { callId, method: "logWhileRunning" }).then(
			(result) => {
				finished = true;
				return result;
			},
		);
		try {
			await vi.waitFor(
				async () => {
					const traces = await runInDurableObject(
						stub,
						async (_instance, state) => [
							...(
								await state.storage.list<{
									callId?: string;
									events: unknown[];
								}>({ prefix: "app-tail:" })
							).values(),
						],
					);
					expect(
						traces.some(
							(trace) =>
								trace.callId === callId &&
								JSON.stringify(trace.events).includes("still running"),
						),
					).toBe(true);
					expect(finished).toBe(false);
				},
				{ timeout: 4000 },
			);
		} finally {
			expect(await running).toBe("finished");
		}
	});
	it("isolates app SQLite from sibling apps and the supervisor", async () => {
		const stub = createHost();
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.kv.put("hostSecret", "parent-only");
		});
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
		expect(
			await call(stub, { gadget: "44444444-4444-4444-8444-444444444444" }),
		).toEqual({ n: 1, version: "v1" });
		expect(await call(stub, { method: "readHost" })).toBe(null);
	});
	it("aborts old code on revision changes and preserves app SQLite", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(
			await call(stub, {
				revision: "55555555-5555-4555-8555-555555555555",
				version: "v2",
			}),
		).toEqual({ n: 2, version: "v2" });
	});
	it("gives a preview its own SQLite", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(
			await call(stub, { previewId: "66666666-6666-4666-8666-666666666666" }),
		).toEqual({ n: 1, version: "v1" });
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});
	it("runs a trigger's machine session like a caller with the same role", async () => {
		const stub = createHost();
		const trigger = {
			principalKind: "app_trigger",
			principal: `${gadgetId}:morning`,
		};
		expect(await call(stub, trigger)).toEqual({ n: 1, version: "v1" });
		// A departed author gets no app invocation, including local SQLite writes.
		await expect(
			call(stub, { ...trigger, role: "viewer", method: "count" }),
		).rejects.toThrow("App interaction requires use access");
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});
	it("blocks global fetch and refuses build operations for a use session", async () => {
		const stub = createHost();
		expect(await call(stub, { method: "network" })).toBe("blocked");
		expect(await call(stub, { method: "importEnv" })).toBe("blocked");
		await expect(call(stub, { method: "build" })).rejects.toThrow(
			/outputsWrite/,
		);
	});
	it("does not retain build authority when the next caller has use access", async () => {
		const stub = createHost();
		expect(await call(stub, { method: "build", role: "build" })).toEqual({
			recorded: true,
		});
		await expect(call(stub, { method: "build", role: "use" })).rejects.toThrow(
			/outputsWrite/,
		);
		expect(await call(stub, { method: "remember", role: "build" })).toBe(true);
		await expect(call(stub, { method: "reuse", role: "use" })).rejects.toThrow(
			"App capability expired",
		);
	});
	it("cuts a removed principal's live session and restarts apps without losing storage", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		const live = await mint(stub, files("v1"));
		const issuedAt = live.expiresAt - 300;
		expect(
			await stub.revokeSessions({
				organizationId: "fictional-org",
				workspaceId: hostWorkspaces.get(stub)!,
				principalIds: ["fictional-member"],
				at: issuedAt,
			}),
		).toEqual({ restarted: 1 });
		await expect(call(stub, { token: live.token })).rejects.toThrow(
			"App access changed",
		);
		expect(await call(stub, { principal: "fictional-other" })).toEqual({
			n: 2,
			version: "v1",
		});
		const foreignScopeError = await stub
			.revokeSessions({
				organizationId: "another-org",
				workspaceId: hostWorkspaces.get(stub)!,
				principalIds: [],
				at: issuedAt,
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(String(foreignScopeError)).toContain(
			"Workspace host scope mismatch",
		);
	});
	it("durably queues failed trace writes and redrives them through an alarm", async () => {
		const stub = createHost();
		await call(stub);
		const tailId = crypto.randomUUID();
		await stub.recordTail({
			tailId,
			organizationId: "fictional-org",
			workspaceId: hostWorkspaces.get(stub)!,
			gadgetId,
			revisionId,
			events: [{ outcome: "fixture_unavailable" }],
		});
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, async (_instance, state) => {
					const pending = await state.storage.get(`app-tail:${tailId}`);
					return Boolean(pending) && (await state.storage.getAlarm()) !== null;
				}),
			).toBe(true),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			const key = `app-tail:${tailId}`;
			const trace = await state.storage.get<Record<string, unknown>>(key);
			await state.storage.put(key, { ...trace, events: [{ outcome: "ok" }] });
		});
		await runDurableObjectAlarm(stub);
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, (_instance, state) =>
					state.storage.get(`app-tail:${tailId}`),
				),
			).toBeUndefined(),
		);
	});
});

describe("proposal facet lifecycle", () => {
	it("runs different draft code in fresh storage and deletes only the rejected facet", async () => {
		const stub = createHost();
		const previewId = crypto.randomUUID();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(await call(stub, { previewId, version: "draft" })).toEqual({
			n: 1,
			version: "draft",
		});
		expect(await call(stub, { previewId, version: "draft" })).toEqual({
			n: 2,
			version: "draft",
		});
		const token = (await mint(stub, files("draft"), { previewId })).token;
		await stub.closeDraft({
			organizationId: "fictional-org",
			workspaceId: hostWorkspaces.get(stub)!,
			gadgetId,
			proposalId: previewId,
			baseRevisionId: revisionId,
			merged: false,
		});
		await expect(
			call(stub, { previewId, version: "draft", token }),
		).rejects.toThrow("App draft closed");
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
		expect(
			await call(stub, { previewId: crypto.randomUUID(), version: "other" }),
		).toEqual({ n: 1, version: "other" });
		expect(
			await runInDurableObject(stub, (_instance, state) =>
				state.storage.kv.get(`code:app:${gadgetId}:draft:${previewId}`),
			),
		).toBeUndefined();
	});
	it("closes a merged preview and loads the new code while preserving live storage", async () => {
		const stub = createHost();
		const previewId = crypto.randomUUID();
		await call(stub);
		await call(stub, { previewId, version: "v2" });
		await stub.closeDraft({
			organizationId: "fictional-org",
			workspaceId: hostWorkspaces.get(stub)!,
			gadgetId,
			proposalId: previewId,
			baseRevisionId: revisionId,
			merged: true,
		});
		await expect(call(stub)).rejects.toThrow("App revision changed");
		expect(
			await call(stub, { revision: crypto.randomUUID(), version: "v2" }),
		).toEqual({ n: 2, version: "v2" });
		await expect(call(stub, { previewId, version: "v2" })).rejects.toThrow(
			"App draft closed",
		);
	});
	it("reads a published revision's stored code when a warm call carries none", async () => {
		const DB = (env as unknown as { DB: D1Database }).DB;
		for (const ddl of [osGadgetCode, osGadgetCodeBlobs].flatMap((table) =>
			tableDdl(table, { foreignKeys: false }),
		))
			await DB.prepare(
				ddl
					.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
					.replace(/CREATE INDEX /g, "CREATE INDEX IF NOT EXISTS "),
			).run();
		const store = (revision: string, code: Record<string, string>) =>
			DB.prepare(
				"INSERT INTO os_gadget_code (revision_id, organization_id, gadget_id, files, code_length, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
			)
				.bind(revision, "fictional-org", gadgetId, JSON.stringify(code), 1)
				.run();
		const stub = createHost();
		const revision = crypto.randomUUID();
		await store(revision, files("stored"));
		const { token } = await mint(stub, files("stored"), { revision });
		const bare = (method = "count") =>
			stub.call({ session: token, method, args: [] });
		expect(await bare()).toEqual({ n: 1, version: "stored" });
		expect(await bare()).toEqual({ n: 2, version: "stored" });

		// Stored code that does not hash to the signed digest never runs.
		const tampered = createHost();
		const other = crypto.randomUUID();
		await store(other, files("tampered"));
		const signed = await mint(tampered, files("signed"), { revision: other });
		await expect(
			tampered.call({ session: signed.token, method: "count", args: [] }),
		).rejects.toThrow();

		// A draft always arrives with its files.
		const draft = await mint(stub, files("draft"), {
			previewId: crypto.randomUUID(),
		});
		await expect(
			stub.call({ session: draft.token, method: "count", args: [] }),
		).rejects.toThrow("App code does not match the signed revision");
	});
});
