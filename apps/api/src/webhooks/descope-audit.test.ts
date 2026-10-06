/** Signed webhook boundary and actual SQLite/D1 persistence regressions. */

import { DatabaseSync } from "node:sqlite";
import { organizations } from "@tedix/db/schema/organizations";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import type { Context } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleDescopeAuditWebhook } from "./descope-audit";

const SECRET = "test-webhook-secret";

async function sign(body: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	let binary = "";
	for (const b of new Uint8Array(sig)) binary += String.fromCharCode(b);
	return btoa(binary);
}

function fakeContext(input: {
	body: string;
	signature?: string;
	secret?: string;
	contentLength?: string;
}): Context<{ Bindings: CloudflareEnv }> {
	const headers: Record<string, string | undefined> = {
		"x-descope-webhook-s256": input.signature,
		"content-length": input.contentLength,
	};
	return {
		env: {
			ENVIRONMENT: "test",
			...(input.secret !== undefined
				? { DESCOPE_WEBHOOK_SECRET: input.secret }
				: {}),
		},
		req: {
			text: async () => input.body,
			header: (name: string) => headers[name.toLowerCase()],
		},
		json: (payload: unknown, status?: number) =>
			Response.json(payload, { status: status ?? 200 }),
	} as unknown as Context<{ Bindings: CloudflareEnv }>;
}

describe("handleDescopeAuditWebhook signature gate", () => {
	it("fails closed with 500 when DESCOPE_WEBHOOK_SECRET is not configured", async () => {
		const body = JSON.stringify({ events: [] });
		const response = await handleDescopeAuditWebhook(
			fakeContext({ body, signature: await sign(body, SECRET) }),
		);
		expect(response.status).toBe(500);
	});

	it("rejects a request with no signature header", async () => {
		const response = await handleDescopeAuditWebhook(
			fakeContext({ body: JSON.stringify({ events: [] }), secret: SECRET }),
		);
		expect(response.status).toBe(401);
	});

	it("rejects a wrong-key signature", async () => {
		const body = JSON.stringify({ events: [] });
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body,
				secret: SECRET,
				signature: await sign(body, "some-other-secret"),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("keeps signature denial and omits caught error text from diagnostics", async () => {
		const body = JSON.stringify({ events: [] });
		const signature = await sign(body, SECRET);
		const signSpy = vi
			.spyOn(crypto.subtle, "sign")
			.mockRejectedValueOnce(new Error("private-signature-error-marker"));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handleDescopeAuditWebhook(
				fakeContext({ body, secret: SECRET, signature }),
			);
			expect(response.status).toBe(401);
			const output = errorLog.mock.calls.flat().map(String).join("\n");
			expect(output).toContain("descope_audit.signature_verification_failed");
			expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
				event: "descope_audit.signature_verification_failed",
				exception: {
					name: "Error",
					message: { sha256: expect.any(String) },
				},
			});
			expect(output).not.toContain("private-signature-error-marker");
			expect(output).not.toContain(body);
		} finally {
			signSpy.mockRestore();
			errorLog.mockRestore();
		}
	});

	it("rejects a valid signature over a DIFFERENT body (tamper)", async () => {
		const signedBody = JSON.stringify({ events: [{ action: "original" }] });
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body: JSON.stringify({ events: [{ action: "tampered" }] }),
				secret: SECRET,
				signature: await sign(signedBody, SECRET),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("rejects a truncated signature (timing-safe length check)", async () => {
		const body = JSON.stringify({ events: [] });
		const full = await sign(body, SECRET);
		const response = await handleDescopeAuditWebhook(
			fakeContext({ body, secret: SECRET, signature: full.slice(0, 12) }),
		);
		expect(response.status).toBe(401);
	});

	it("rejects an unexpected signed shape before database access", async () => {
		const body = JSON.stringify({ unexpected: true });
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body,
				secret: SECRET,
				signature: await sign(body, SECRET),
			}),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "Invalid audit batch",
		});
	});
});

/**
 * Declared oversize bodies are rejected before reading. Actual byte length is
 * checked after buffering and before HMAC/JSON; this is not a streaming limit
 * on allocation for absent or misleading Content-Length headers.
 */
describe("handleDescopeAuditWebhook body cap", () => {
	const OVER = 1024 * 1024 + 1;

	it("rejects a declared oversize body with 413 before reading it", async () => {
		let read = false;
		const ctx = fakeContext({
			body: "{}",
			contentLength: String(OVER),
			secret: SECRET,
		});
		// Prove the early reject never touches the body.
		(ctx.req as unknown as { text: () => Promise<string> }).text = async () => {
			read = true;
			return "{}";
		};

		const response = await handleDescopeAuditWebhook(ctx);

		expect(response.status).toBe(413);
		expect(read).toBe(false);
	});

	it("rejects an undeclared oversize body once read, before HMAC", async () => {
		// No content-length (chunked). A VALID signature is supplied so the only
		// thing that can produce 413 is the byte-length check itself.
		const body = "x".repeat(OVER);
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body,
				signature: await sign(body, SECRET),
				secret: SECRET,
			}),
		);

		expect(response.status).toBe(413);
	});

	it("accepts a body at the limit", async () => {
		// Exactly at the cap must pass the size gate; an unexpected payload shape
		// then fails envelope validation without touching the DB.
		const limit = 1024 * 1024;
		const overhead = new TextEncoder().encode(
			JSON.stringify({ pad: "" }),
		).byteLength;
		const filler = "y".repeat(limit - overhead);
		const body = JSON.stringify({ pad: filler });
		expect(new TextEncoder().encode(body).byteLength).toBe(limit);
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body,
				signature: await sign(body, SECRET),
				secret: SECRET,
			}),
		);

		expect(response.status).toBe(400);
	});

	it("does not let a lying content-length smuggle an oversize body", async () => {
		const body = "z".repeat(OVER);
		const response = await handleDescopeAuditWebhook(
			fakeContext({
				body,
				contentLength: "10",
				signature: await sign(body, SECRET),
				secret: SECRET,
			}),
		);

		expect(response.status).toBe(413);
	});
});

function auditFixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations));
	sqlite.exec(schemaDdl(auditEvents));
	for (const suffix of ["a", "b"])
		sqlite
			.prepare(
				"INSERT INTO organizations(id,name,slug,descope_tenant_id) VALUES(?,?,?,?)",
			)
			.run(`org-${suffix}`, suffix, suffix, `tenant-${suffix}`);
	return {
		sqlite,
		binding: createD1Facade(sqlite),
		rows: () =>
			sqlite.prepare("SELECT * FROM audit_events ORDER BY actor_id").all(),
	};
}
const auditEvent = (actorId: string) => ({
	action: "LoginSucceed",
	actorId,
	userId: actorId,
	occurred: 1780949905843,
	tenants: ["tenant-a"],
});
async function signedContext(payload: unknown, binding: D1Database) {
	const body = JSON.stringify(payload);
	const ctx = fakeContext({
		body,
		signature: await sign(body, SECRET),
		secret: SECRET,
	});
	ctx.env.DB = binding;
	const pending: Promise<unknown>[] = [];
	Object.defineProperty(ctx, "executionCtx", {
		value: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
	});
	return { ctx, pending };
}
describe("Descope durable batch acknowledgement", () => {
	it("persists numeric milliseconds and preserves tenant mapping and explicit skips", async () => {
		const f = auditFixture();
		try {
			const { ctx, pending } = await signedContext(
				[
					{
						...auditEvent("numeric"),
						projectId: "project",
						occurred_formatted: "2026-06-08T20:18:25.843Z",
						data: { nested: { value: 1780949905843 } },
						tenants: ["missing", "tenant-b", "tenant-a"],
					},
					{ ...auditEvent("unmapped"), tenants: null },
				],
				f.binding,
			);
			const response = await handleDescopeAuditWebhook(ctx);
			await Promise.all(pending);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				processed: 1,
				skipped: 1,
			});
			expect(f.rows()).toEqual([
				expect.objectContaining({
					actor_id: "numeric",
					organization_id: "org-b",
					timestamp: 1780949905,
					metadata: JSON.stringify({
						data: { nested: { value: 1780949905843 } },
						tenants: ["missing", "tenant-b", "tenant-a"],
						projectId: "project",
						occurred_formatted: "2026-06-08T20:18:25.843Z",
					}),
				}),
			]);
		} finally {
			f.sqlite.close();
		}
	});
	it("validates all events before any writes", async () => {
		const f = auditFixture();
		try {
			const { ctx, pending } = await signedContext(
				[
					auditEvent("valid"),
					{ ...auditEvent("invalid"), occurred: "1780949905843" },
				],
				f.binding,
			);
			const response = await handleDescopeAuditWebhook(ctx);
			await Promise.all(pending);
			expect(response.status).toBe(400);
			expect(f.rows()).toEqual([]);
		} finally {
			f.sqlite.close();
		}
	});
	it("fails a partial batch and replays safely through actual D1 insert/dedup", async () => {
		const f = auditFixture();
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			f.sqlite.exec(
				"CREATE TRIGGER synthetic_failure BEFORE INSERT ON audit_events WHEN NEW.actor_id='middle' BEGIN SELECT RAISE(ABORT,'private-ingestion-error-marker'); END;",
			);
			const payload = [
				auditEvent("first"),
				auditEvent("middle"),
				auditEvent("third"),
			];
			const first = await signedContext(payload, f.binding);
			const failed = await handleDescopeAuditWebhook(first.ctx);
			await Promise.all(first.pending);
			expect(failed.status).toBe(503);
			const output = errorLog.mock.calls.flat().map(String).join("\n");
			expect(output).toContain("descope_audit.ingestion_failed");
			expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
				event: "descope_audit.ingestion_failed",
				exception: {
					name: expect.any(String),
					message: { sha256: expect.any(String) },
				},
			});
			expect(output).not.toContain("private-ingestion-error-marker");
			expect(output).not.toContain("middle");
			expect(f.rows()).toHaveLength(1);
			const original = f.rows()[0];
			f.sqlite.exec("DROP TRIGGER synthetic_failure");
			for (let i = 0; i < 2; i++) {
				const retry = await signedContext(payload, f.binding);
				expect((await handleDescopeAuditWebhook(retry.ctx)).status).toBe(200);
				await Promise.all(retry.pending);
				expect(f.rows()).toHaveLength(3);
				expect(f.rows()[0]).toEqual(original);
			}
		} finally {
			errorLog.mockRestore();
			f.sqlite.close();
		}
	});
	it("does not acknowledge while persistence is pending", async () => {
		const f = auditFixture();
		let release!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const entered = new Promise<void>((r) => (reached = r));
		const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
			new Proxy(statement, {
				get(target, key) {
					if (key === "bind")
						return (...args: unknown[]) => wrap(target.bind(...args));
					if (key === "run")
						return async () => {
							reached();
							await gate;
							return target.run();
						};
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		const binding = new Proxy(f.binding, {
			get(target, key) {
				if (key === "prepare")
					return (sql: string) => wrap(target.prepare(sql));
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		try {
			const { ctx, pending } = await signedContext(
				[auditEvent("delayed")],
				binding,
			);
			let settled = false;
			const response = handleDescopeAuditWebhook(ctx).then((r) => {
				settled = true;
				return r;
			});
			await entered;
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(f.rows()).toEqual([]);
			release();
			expect((await response).status).toBe(200);
			await Promise.all(pending);
			expect(f.rows()).toHaveLength(1);
		} finally {
			release();
			f.sqlite.close();
		}
	});
	it("returns lookup failure rather than unmapped success", async () => {
		const f = auditFixture();
		try {
			f.sqlite.exec("DROP TABLE organizations");
			const { ctx, pending } = await signedContext(
				[auditEvent("lookup")],
				f.binding,
			);
			const response = await handleDescopeAuditWebhook(ctx);
			await Promise.all(pending);
			expect(response.status).toBe(503);
			expect(f.rows()).toEqual([]);
		} finally {
			f.sqlite.close();
		}
	});
});
