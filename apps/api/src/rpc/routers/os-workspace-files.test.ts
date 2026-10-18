import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osWorkspaceResources,
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/schema/os-workspaces";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { describe, it, expect, vi, onTestFinished } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	requestFileUpload,
	confirmFileUpload,
	getFile,
} from "./os-workspace-files";
import {
	uploadWorkspaceFilePart,
	serveWorkspaceFile,
} from "../../lib/workspace-file-routes";
import {
	workspaceFileKey,
	workspaceFileSignature,
} from "../../lib/workspace-files";
import {
	WORKSPACE_FILE_MAX_BYTES,
	WORKSPACE_FILE_PART_BYTES,
} from "@tedix/api-contract/schemas/workspace-files";

const W = "10000000-0000-4000-8000-000000000001";
// Exercise the real authorization middleware with an already-authenticated fictional caller.
const authentication = vi.hoisted(() => ({
	context: null as BaseContext | null,
}));
vi.mock("../orpc", async (importOriginal) => ({
	...(await importOriginal<typeof import("../orpc")>()),
	createContext: () => authentication.context!,
}));

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			osWorkspaceResources,
			osOutputs,
			osOutputRevisions,
			auditEvents,
		),
	);
	sqlite.exec(
		`INSERT INTO os_workspaces (id,organization_id,name,status,created_by_kind,created_by_id,created_at,updated_at) VALUES ('${W}','fictional-a','Files','active','user','robin','2026-01-01','2026-01-01')`,
	);
	const objects = new Map<string, Uint8Array>();
	const uploads = new Map<
		string,
		{ key: string; parts: Map<number, { etag: string; bytes: Uint8Array }> }
	>();
	const bucket = {
		put: async (key: string, value: string) => {
			objects.set(key, new TextEncoder().encode(value));
		},
		get: async (
			key: string,
			options?: { range: { offset: number; length: number } },
		) => {
			const bytes = objects.get(key);
			if (!bytes) return null;
			const slice = options
				? bytes.slice(
						options.range.offset,
						options.range.offset + options.range.length,
					)
				: bytes;
			return {
				size: bytes.length,
				body: slice,
				json: async () => JSON.parse(new TextDecoder().decode(bytes)),
			};
		},
		head: async (key: string) => {
			const bytes = objects.get(key);
			return bytes ? { size: bytes.length } : null;
		},
		createMultipartUpload: async (key: string) => {
			const uploadId = crypto.randomUUID();
			uploads.set(uploadId, { key, parts: new Map() });
			return { uploadId, abort: async () => uploads.delete(uploadId) };
		},
		resumeMultipartUpload: (key: string, uploadId: string) => ({
			uploadPart: async (partNumber: number, bytes: Uint8Array) => {
				const upload = uploads.get(uploadId);
				if (!upload || upload.key !== key) throw new Error("No upload");
				const etag = `part-${partNumber}-${bytes.length}`;
				upload.parts.set(partNumber, { bytes, etag });
				return { partNumber, etag };
			},
			complete: async (parts: Array<{ partNumber: number; etag: string }>) => {
				const upload = uploads.get(uploadId);
				if (!upload) throw new Error("No upload");
				const chunks = parts.map((part) => {
					const stored = upload.parts.get(part.partNumber);
					if (!stored || stored.etag !== part.etag)
						throw new Error("Bad receipt");
					return stored.bytes;
				});
				const bytes = new Uint8Array(
					chunks.reduce((n, chunk) => n + chunk.length, 0),
				);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.length;
				}
				objects.set(key, bytes);
				uploads.delete(uploadId);
			},
		}),
	};
	const env = {
		ENVIRONMENT: "test",
		API_URL: "https://api.example.test",
		SECRETS_MASTER_KEY: "fictional-test-secret",
		DB: createD1Facade(sqlite),
		SKILL_ARTIFACTS: bucket,
	} as unknown as CloudflareEnv;
	function context(
		org = "fictional-a",
		scopes = ["apps:read", "apps:write"],
	): BaseContext {
		return {
			env,
			db: createDbClient(env.DB),
			organizationId: org,
			authType: "apikey",
			apiKey: { id: "fictional-key", scopes, organizationId: org },
			url: new URL(env.API_URL),
			headers: new Headers(),
		} as BaseContext;
	}
	const caller = context();
	authentication.context = caller;
	const request = createRouterClient(requestFileUpload, { context: caller });
	const confirm = createRouterClient(confirmFileUpload, { context: caller });
	const get = createRouterClient(getFile, { context: caller });
	async function upload(size = 6, mimeType = "video/mp4") {
		const ticket = await request({
			workspaceId: W,
			filename: "demo.mp4",
			mimeType,
			size,
		});
		const receipts = [];
		for (const part of ticket.parts) {
			const u = new URL(part.url);
			const response = await uploadWorkspaceFilePart(
				new Request(u, { method: "PUT", body: new Uint8Array(part.size) }),
				env,
				{
					organizationId: "fictional-a",
					workspaceId: W,
					resourceId: ticket.resourceId,
					partNumber: String(part.partNumber),
				},
			);
			expect(response.status).toBe(200);
			receipts.push(
				(await response.json()) as { partNumber: number; etag: string },
			);
		}
		return { ticket, receipts };
	}
	return { env, sqlite, context, request, confirm, get, upload, objects };
}

describe("workspace file uploads", () => {
	it("confirms a binary upload into one Resource and Output and retries without duplicates", async () => {
		const f = fixture();
		const { ticket, receipts } = await f.upload();
		const input = {
			workspaceId: W,
			resourceId: ticket.resourceId,
			parts: receipts,
		};
		const first = await f.confirm(input);
		const second = await f.confirm(input);
		expect(second.outputId).toBe(first.outputId);
		expect(first.resource.metadata).toEqual({ mimeType: "video/mp4", size: 6 });
		expect(
			f.sqlite.prepare("SELECT COUNT(*) AS n FROM os_workspace_resources").get()
				?.n,
		).toBe(1);
		expect(
			f.sqlite.prepare("SELECT COUNT(*) AS n FROM os_outputs").get()?.n,
		).toBe(1);
		const content = f.sqlite
			.prepare("SELECT content FROM os_output_revisions")
			.get()?.content;
		expect(JSON.parse(String(content)).file.resourceId).toBe(ticket.resourceId);
		const file = await f.get({ workspaceId: W, resourceId: ticket.resourceId });
		const url = new URL(file.url.replace(/^\/api/, ""), f.env.API_URL);
		const params = {
			organizationId: "fictional-a",
			workspaceId: W,
			resourceId: ticket.resourceId,
		};
		const response = await serveWorkspaceFile(
			new Request(url, { headers: { Range: "bytes=1-3" } }),
			f.env,
			params,
		);
		expect(response.status).toBe(206);
		expect(response.headers.get("Content-Range")).toBe("bytes 1-3/6");
		expect((await response.arrayBuffer()).byteLength).toBe(3);
		expect(
			(
				await serveWorkspaceFile(
					new Request(url, { headers: { Range: "bytes=-2" } }),
					f.env,
					params,
				)
			).headers.get("Content-Range"),
		).toBe("bytes 4-5/6");
		expect(
			(
				await serveWorkspaceFile(
					new Request(url, { headers: { Range: "bytes=9-" } }),
					f.env,
					params,
				)
			).status,
		).toBe(416);
		// A previously minted URL cannot survive resource revocation.
		f.sqlite.exec("UPDATE os_workspace_resources SET status='removed'");
		expect(
			(await serveWorkspaceFile(new Request(url), f.env, params)).status,
		).toBe(404);
	});
	it("binds tenant, workspace, scope and private owner before issuing capabilities", async () => {
		const f = fixture();
		const { ticket, receipts } = await f.upload();
		await expect(
			createRouterClient(confirmFileUpload, {
				context: f.context("fictional-b"),
			})({ workspaceId: W, resourceId: ticket.resourceId, parts: receipts }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			createRouterClient(requestFileUpload, {
				context: f.context("fictional-a", ["apps:read"]),
			})({
				workspaceId: W,
				filename: "test.pdf",
				mimeType: "application/pdf",
				size: 10,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		f.sqlite.exec(
			"UPDATE os_workspaces SET visibility='private', owner_user_id='robin'",
		);
		await expect(
			f.confirm({
				workspaceId: W,
				resourceId: ticket.resourceId,
				parts: receipts,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
	it("rejects unconfirmed reads, incomplete receipts, oversized files and mismatched bytes", async () => {
		const f = fixture();
		const ticket = await f.request({
			workspaceId: W,
			filename: "test.pdf",
			mimeType: "application/pdf",
			size: 10,
		});
		await expect(
			f.get({ workspaceId: W, resourceId: ticket.resourceId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const params = {
			organizationId: "fictional-a",
			workspaceId: W,
			resourceId: ticket.resourceId,
			partNumber: "1",
		};
		expect(
			(
				await uploadWorkspaceFilePart(
					new Request(ticket.parts[0]!.url, {
						method: "PUT",
						body: new Uint8Array(11),
					}),
					f.env,
					params,
				)
			).status,
		).toBe(413);
		expect(
			(
				await uploadWorkspaceFilePart(
					new Request(ticket.parts[0]!.url, {
						method: "PUT",
						body: new Uint8Array(9),
					}),
					f.env,
					params,
				)
			).status,
		).toBe(400);
		await expect(
			f.request({
				workspaceId: W,
				filename: "too-big.bin",
				mimeType: "application/octet-stream",
				size: WORKSPACE_FILE_MAX_BYTES + 1,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		const max = await f.request({
			workspaceId: W,
			filename: "max.bin",
			mimeType: "application/octet-stream",
			size: WORKSPACE_FILE_MAX_BYTES,
		});
		expect(max.parts).toHaveLength(25);
		expect(max.parts[24]?.size).toBe(WORKSPACE_FILE_PART_BYTES);
		await expect(
			f.confirm({
				workspaceId: W,
				resourceId: max.resourceId,
				parts: [{ partNumber: 1, etag: "incomplete" }],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
	it("does not treat signed links as session-free public shares or let them cross tenants", async () => {
		const f = fixture();
		const { ticket, receipts } = await f.upload();
		await f.confirm({
			workspaceId: W,
			resourceId: ticket.resourceId,
			parts: receipts,
		});
		const file = await f.get({ workspaceId: W, resourceId: ticket.resourceId });
		const url = new URL(file.url.replace(/^\/api/, ""), f.env.API_URL);
		const params = {
			organizationId: "fictional-a",
			workspaceId: W,
			resourceId: ticket.resourceId,
		};
		authentication.context = {
			...f.context(),
			apiKey: undefined,
			authType: undefined,
		} as BaseContext;
		expect(
			(await serveWorkspaceFile(new Request(url), f.env, params)).status,
		).toBe(401);
		authentication.context = f.context("fictional-b");
		expect(
			(await serveWorkspaceFile(new Request(url), f.env, params)).status,
		).toBe(404);
		authentication.context = f.context();
		url.searchParams.set("sig", "tampered");
		expect(
			(await serveWorkspaceFile(new Request(url), f.env, params)).status,
		).toBe(403);
		const exp = Math.floor(Date.now() / 1000) - 1;
		url.searchParams.set("exp", String(exp));
		url.searchParams.set(
			"sig",
			await workspaceFileSignature(
				f.env.SECRETS_MASTER_KEY,
				"read",
				"fictional-a",
				W,
				ticket.resourceId,
				exp,
			),
		);
		expect(
			(await serveWorkspaceFile(new Request(url), f.env, params)).status,
		).toBe(403);
	});
	it("forces active content to download while allowing video, PDF and image previews", async () => {
		const f = fixture();
		const { ticket, receipts } = await f.upload(6, "text/html");
		await f.confirm({
			workspaceId: W,
			resourceId: ticket.resourceId,
			parts: receipts,
		});
		const file = await f.get({ workspaceId: W, resourceId: ticket.resourceId });
		const url = new URL(file.url.replace(/^\/api/, ""), f.env.API_URL);
		const response = await serveWorkspaceFile(new Request(url), f.env, {
			organizationId: "fictional-a",
			workspaceId: W,
			resourceId: ticket.resourceId,
		});
		expect(response.headers.get("Content-Type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("Content-Disposition")).toMatch(/^attachment/);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(
			f.objects.has(workspaceFileKey("fictional-b", W, ticket.resourceId)),
		).toBe(false);
	});
});
