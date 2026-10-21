import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { uploadWorkspaceFilePart } from "./workspace-file-routes";
import {
	workspaceFileSignature,
	type WorkspaceFileManifest,
} from "./workspace-files";

const queries = vi.hoisted(() => ({ getWorkspace: vi.fn() }));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: queries.getWorkspace,
}));
vi.mock("@tedix/db/query-client", () => ({ createDbQueryClient: () => ({}) }));
vi.mock("../rpc/orpc", () => ({ createContext: vi.fn() }));
vi.mock("../rpc/routers/os-workspace-files", () => ({ getFile: vi.fn() }));

const params = {
	organizationId: "fictional-upload-org",
	workspaceId: "10000000-0000-4000-8000-000000000001",
	resourceId: "10000000-0000-4000-8000-000000000002",
	partNumber: "1",
};
const secret = "local-upload-secret";

async function fixture(
	options: {
		part?: string;
		chunks?: number[];
		missingBody?: boolean;
		declared?: string;
		manifest?: "missing" | "expired";
		signature?: "invalid" | "expired";
		openStream?: boolean;
	} = {},
) {
	const routeParams = { ...params, partNumber: options.part ?? "1" };
	const manifest: WorkspaceFileManifest = {
		...params,
		filename: "local-fixture.bin",
		mimeType: "application/octet-stream",
		size: 10,
		uploadId: "local-private-upload-id",
		createdByKind: "user",
		createdById: "local-private-row-id",
		createdAt: new Date().toISOString(),
		expiresAt: new Date(
			Date.now() + (options.manifest === "expired" ? -1000 : 60_000),
		).toISOString(),
	};
	const get = vi.fn(async () =>
		options.manifest === "missing" ? null : { json: async () => manifest },
	);
	const uploadPart = vi.fn(async () => ({ partNumber: 1, etag: "local-etag" }));
	const resumeMultipartUpload = vi.fn(() => ({ uploadPart }));
	const env = {
		SECRETS_MASTER_KEY: secret,
		DB: {},
		SKILL_ARTIFACTS: { get, resumeMultipartUpload },
	} as unknown as CloudflareEnv;
	const exp =
		Math.floor(Date.now() / 1000) + (options.signature === "expired" ? -1 : 60);
	const sig =
		options.signature === "invalid"
			? "invalid-local-signature"
			: await workspaceFileSignature(
					secret,
					`upload:${Number(routeParams.partNumber)}`,
					params.organizationId,
					params.workspaceId,
					params.resourceId,
					exp,
				);
	const url = new URL("https://upload.example.test/part");
	url.searchParams.set("exp", String(exp));
	url.searchParams.set("sig", sig);
	const cancel = vi.fn();
	const chunks = [...(options.chunks ?? [4, 6])];
	const pull = vi.fn(
		(controller: ReadableStreamDefaultController<Uint8Array>) => {
			const size = chunks.shift();
			if (size !== undefined) controller.enqueue(new Uint8Array(size).fill(83));
			else if (!options.openStream) controller.close();
		},
	);
	const body = options.missingBody
		? undefined
		: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
	const init: RequestInit & { duplex: "half" } = {
		method: "PUT",
		body,
		duplex: "half",
		headers:
			options.declared === undefined
				? undefined
				: { "Content-Length": options.declared },
	};
	const request = new Request(url, init);
	return {
		request,
		env,
		routeParams,
		get,
		uploadPart,
		resumeMultipartUpload,
		cancel,
		pull,
		sig,
	};
}

beforeEach(() => {
	queries.getWorkspace.mockReset().mockResolvedValue({ status: "active" });
});

describe("workspace upload rejection copy and boundaries", () => {
	it.each([
		{
			name: "invalid part",
			options: { part: "0", declared: "99" },
			status: 400,
			text: "This file part is invalid. Retry the correct part from the upload instructions.",
		},
		{
			name: "missing body",
			options: { missingBody: true, declared: "99" },
			status: 400,
			text: "This file part has no data. Retry this part with exactly 10 bytes.",
		},
		{
			name: "declared size mismatch",
			options: { declared: "9" },
			status: 400,
			text: "This file part must contain exactly 10 bytes. Retry this part with the correct data.",
		},
		{
			name: "streamed oversize",
			options: { chunks: [4, 7, 1], openStream: true },
			status: 413,
			text: "This file part exceeds the expected 10 bytes. Retry this part with the correct data.",
		},
		{
			name: "incomplete stream",
			options: { chunks: [4, 5] },
			status: 400,
			text: "This file part is incomplete; expected 10 bytes. Retry this part with all its data.",
		},
		{
			name: "expired manifest",
			options: { manifest: "expired" as const },
			status: 410,
			text: "This upload has expired or is no longer available. Request a new upload URL.",
		},
		{
			name: "missing manifest",
			options: { manifest: "missing" as const },
			status: 410,
			text: "This upload has expired or is no longer available. Request a new upload URL.",
		},
		{
			name: "invalid signature",
			options: { signature: "invalid" as const },
			status: 403,
			text: "This upload URL is invalid or has expired. Request a new upload URL.",
		},
		{
			name: "expired signature",
			options: { signature: "expired" as const },
			status: 403,
			text: "This upload URL is invalid or has expired. Request a new upload URL.",
		},
		{
			name: "missing workspace",
			options: {},
			workspace: null,
			status: 404,
			text: "The workspace for this upload is unavailable. Check workspace access and request a new upload URL.",
		},
		{
			name: "inactive workspace",
			options: {},
			workspace: { status: "archived" },
			status: 404,
			text: "The workspace for this upload is unavailable. Check workspace access and request a new upload URL.",
		},
	])(
		"explains $name without uploading or exposing capability material",
		async (test) => {
			const f = await fixture(test.options);
			if ("workspace" in test)
				queries.getWorkspace.mockResolvedValue(test.workspace);
			const response = await uploadWorkspaceFilePart(
				f.request,
				f.env,
				f.routeParams,
			);
			expect(response.status).toBe(test.status);
			const text = await response.text();
			expect(text).toBe(test.text);
			for (const sensitive of [
				secret,
				f.sig,
				params.organizationId,
				params.workspaceId,
				params.resourceId,
				"local-private-upload-id",
				"local-private-row-id",
				"SSSS",
			])
				expect(text).not.toContain(sensitive);
			expect(f.resumeMultipartUpload).not.toHaveBeenCalled();
			expect(f.uploadPart).not.toHaveBeenCalled();
			if (test.status === 403) {
				expect(f.get).not.toHaveBeenCalled();
				expect(queries.getWorkspace).not.toHaveBeenCalled();
			} else if (test.status === 410)
				expect(queries.getWorkspace).not.toHaveBeenCalled();
			if (test.status === 413) {
				expect(f.cancel).toHaveBeenCalledOnce();
				expect(f.pull).toHaveBeenCalledTimes(2);
			} else expect(f.cancel).not.toHaveBeenCalled();
			if (
				test.name !== "streamed oversize" &&
				test.name !== "incomplete stream"
			) {
				expect(f.pull).not.toHaveBeenCalled();
				expect(f.request.body?.locked ?? false).toBe(false);
			}
		},
	);

	it("still uploads exactly sized streamed bytes once", async () => {
		const f = await fixture({ declared: "10" });
		const response = await uploadWorkspaceFilePart(
			f.request,
			f.env,
			f.routeParams,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			partNumber: 1,
			etag: "local-etag",
		});
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(f.uploadPart).toHaveBeenCalledExactlyOnceWith(
			1,
			new Uint8Array(10).fill(83),
		);
		expect(f.cancel).not.toHaveBeenCalled();
	});
});
