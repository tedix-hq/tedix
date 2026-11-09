import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	handleWorkspaceAppImport,
	handleWorkspaceAppImportPlan,
} from "../../src/workspace-app-route";

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
		role?: "owner" | "build" | "use" | "viewer";
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
});

describe("recovered storage import", () => {
	it("writes only absent keys, keeps newer state and reloads the app", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		const code = files("v1");
		const owner = (await mint(stub, code, { role: "owner" })).token;
		const entries: { key: string; value: JsonValue }[] = [
			{ key: "n", value: 40 },
			{ key: "tags", value: { $set: ["a", "b"] } },
			{ key: "seen", value: { $map: [["x", { $date: 0 }]] } },
		];
		const dry = await stub.importRecoveredStorage({
			session: owner,
			files: code,
			entries,
			apply: false,
		});
		expect(dry.results.map((r) => r.status)).toEqual([
			"present",
			"absent",
			"absent",
		]);
		const applied = await stub.importRecoveredStorage({
			session: owner,
			files: code,
			entries,
			apply: true,
		});
		expect(applied.results).toEqual([
			{ key: "n", status: "skipped", matches: false },
			{ key: "tags", status: "written", matches: true },
			{ key: "seen", status: "written", matches: true },
		]);
		const readBack = await stub.importRecoveredStorage({
			session: owner,
			files: code,
			entries,
			apply: false,
		});
		expect(readBack.results.map((r) => [r.status, r.matches])).toEqual([
			["present", false],
			["present", true],
			["present", true],
		]);
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});

	it("refuses a session that is not the owner's or code that does not match", async () => {
		const stub = createHost();
		const code = files("v1");
		const use = (await mint(stub, code)).token;
		await expect(
			(async () =>
				await stub.importRecoveredStorage({
					session: use,
					files: code,
					entries: [{ key: "n", value: 1 }],
					apply: true,
				}))(),
		).rejects.toThrow("owner session");
		const owner = (await mint(stub, code, { role: "owner" })).token;
		await expect(
			(async () =>
				await stub.importRecoveredStorage({
					session: owner,
					files: files("v2"),
					entries: [{ key: "n", value: 1 }],
					apply: true,
				}))(),
		).rejects.toThrow("signed revision");
	});
});

describe("recovered archive import route", () => {
	const hex = async (text: string) =>
		[
			...new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
			),
		]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	async function putArchive(workspaceId: string, prefix: string) {
		const bucket = (env as unknown as { TEDI_STORAGE: R2Bucket }).TEDI_STORAGE;
		const host = "a".repeat(64);
		const files = {
			[`${host}/kv.0000.jsonl`]: `${JSON.stringify({ key: "scope", value: `fictional-org:${workspaceId}` })}\n`,
			[`${host}/facets/app%3A${gadgetId}/kv.0000.jsonl`]: `${JSON.stringify({ key: "n", value: 9 })}\n${JSON.stringify({ key: "notes", value: { text: "kept" } })}\n`,
		};
		const manifest = JSON.stringify(
			await Promise.all(
				Object.entries(files).map(async ([path, body]) => ({
					key: `account-recovery/v1/fixture/app-host-export/${path}`,
					sha256: await hex(body),
				})),
			),
		);
		for (const [path, body] of Object.entries(files))
			await bucket.put(`${prefix}${path}`, body);
		await bucket.put(`${prefix}manifest.json`, manifest);
		return { bucket, manifestSha256: await hex(manifest), host };
	}
	const post = (body: unknown) =>
		new Request("https://tedi-runtime/", {
			method: "POST",
			headers: { "X-Service-Binding": "true" },
			body: JSON.stringify(body),
		});

	it("reads the archive from the runtime bucket and imports only absent keys", async () => {
		const stub = createHost();
		const workspaceId = hostWorkspaces.get(stub)!;
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		const prefix = `account-recovery/${workspaceId}/`;
		const archive = await putArchive(workspaceId, prefix);
		const routeEnv = env as unknown as Parameters<
			typeof handleWorkspaceAppImport
		>[1];
		const plan = await handleWorkspaceAppImportPlan(
			post({ prefix, manifestSha256: archive.manifestSha256 }),
			routeEnv,
		);
		expect(await plan.json()).toEqual({
			apps: [
				{
					organizationId: "fictional-org",
					workspaceId,
					gadgetId,
					entryCount: 2,
				},
			],
		});
		const code = files("v1");
		const session = (await mint(stub, code, { role: "owner" })).token;
		const imported = await handleWorkspaceAppImport(
			post({
				prefix,
				manifestSha256: archive.manifestSha256,
				session,
				files: code,
				apply: true,
			}),
			routeEnv,
		);
		expect(((await imported.json()) as { results: unknown }).results).toEqual([
			{ key: "n", status: "skipped", matches: false },
			{ key: "notes", status: "written", matches: true },
		]);
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});

	it("refuses an archive whose manifest or file hash does not match", async () => {
		const stub = createHost();
		const workspaceId = hostWorkspaces.get(stub)!;
		const prefix = `account-recovery/${workspaceId}/`;
		const archive = await putArchive(workspaceId, prefix);
		const routeEnv = env as unknown as Parameters<
			typeof handleWorkspaceAppImport
		>[1];
		await expect(
			handleWorkspaceAppImportPlan(
				post({ prefix, manifestSha256: "0".repeat(64) }),
				routeEnv,
			),
		).rejects.toThrow("manifest hash mismatch");
		await archive.bucket.put(
			`${prefix}${archive.host}/facets/app%3A${gadgetId}/kv.0000.jsonl`,
			"{}\n",
		);
		await expect(
			handleWorkspaceAppImportPlan(
				post({ prefix, manifestSha256: archive.manifestSha256 }),
				routeEnv,
			),
		).rejects.toThrow("file hash mismatch");
	});
});
