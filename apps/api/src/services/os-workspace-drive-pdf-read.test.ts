import { describe, expect, it, vi } from "vite-plus/test";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import type { BaseContext } from "../rpc/orpc";
import {
	readWorkspaceDrivePdf,
	splitPdfPages,
} from "./os-workspace-drive-pdf-read";

const resource = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "org-1",
	providerId: "google-drive",
	providerResourceId: "drive-file-1",
	connectionScope: "tenant",
} as OsWorkspaceResourceRow;
const context = { env: {} } as BaseContext;
const pdfBytes = new TextEncoder().encode("%PDF-1.7\ntest");

function providerFetch(metadataMime = "application/pdf") {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer secret-token",
		});
		const parsed = new URL(String(url));
		expect(parsed.host).toBe("www.googleapis.com");
		expect(parsed.pathname).toBe("/drive/v3/files/drive-file-1");
		if (parsed.searchParams.get("alt") === "media") {
			return new Response(pdfBytes, {
				headers: { "content-type": "application/pdf" },
			});
		}
		return Response.json({
			id: "drive-file-1",
			name: "CSF.pdf",
			mimeType: metadataMime,
			modifiedTime: "2026-09-26T00:00:00Z",
			version: "42",
		});
	}) as unknown as typeof fetch;
}

const ai = {
	toMarkdown: vi.fn(async () => ({
		format: "markdown" as const,
		data: "# certificate.pdf\n## Metadata\n- Title=Certificate\n## Contents\n### Page 1\nLegal entity Example Company\n### Page 2\nTax ID EXAMPLE-123",
		tokens: 20,
	})),
} as unknown as Pick<Ai, "toMarkdown">;

describe("Workspace Google Drive PDF read", () => {
	it("reads only the bound file and returns page text with a byte hash", async () => {
		const fetchImpl = providerFetch();
		const result = await readWorkspaceDrivePdf(
			context,
			{
				resource,
				requiredScopes: [],
				pageStart: 2,
				pageLimit: 1,
				charOffset: 0,
			},
			{ resolveToken: async () => "secret-token", fetchImpl, ai },
		);
		expect(result).toMatchObject({
			resourceId: resource.id,
			providerResourceId: "drive-file-1",
			fileName: "CSF.pdf",
			version: "42",
			totalPages: 2,
			pages: [{ page: 2, text: "Tax ID EXAMPLE-123", truncated: false }],
		});
		expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result)).not.toContain("secret-token");
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});

	it("rejects a provider revision that changes between metadata and bytes", async () => {
		let metadataReads = 0;
		const localAi = { toMarkdown: vi.fn() } as unknown as Pick<
			Ai,
			"toMarkdown"
		>;
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (new URL(String(url)).searchParams.get("alt") === "media") {
				return new Response(pdfBytes);
			}
			metadataReads += 1;
			return Response.json({
				id: "drive-file-1",
				name: "CSF.pdf",
				mimeType: "application/pdf",
				modifiedTime: "2026-09-26T00:00:00Z",
				version: String(metadataReads),
			});
		}) as unknown as typeof fetch;
		await expect(
			readWorkspaceDrivePdf(
				context,
				{
					resource,
					requiredScopes: [],
					pageStart: 1,
					pageLimit: 1,
					charOffset: 0,
				},
				{ resolveToken: async () => "secret-token", fetchImpl, ai: localAi },
			),
		).rejects.toThrow("changed during the read");
		expect(localAi.toMarkdown).not.toHaveBeenCalled();
	});

	it("rejects non-PDF metadata before downloading content", async () => {
		const fetchImpl = providerFetch("application/vnd.google-apps.document");
		await expect(
			readWorkspaceDrivePdf(
				context,
				{
					resource,
					requiredScopes: [],
					pageStart: 1,
					pageLimit: 1,
					charOffset: 0,
				},
				{ resolveToken: async () => "secret-token", fetchImpl, ai },
			),
		).rejects.toThrow("not a PDF");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("caps bytes while streaming even without Content-Length", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			if (new URL(String(url)).searchParams.get("alt") !== "media") {
				return Response.json({
					id: "drive-file-1",
					name: "CSF.pdf",
					mimeType: "application/pdf",
				});
			}
			return new Response(new Uint8Array(2 * 1024 * 1024 + 1));
		}) as unknown as typeof fetch;
		await expect(
			readWorkspaceDrivePdf(
				context,
				{
					resource,
					requiredScopes: [],
					pageStart: 1,
					pageLimit: 1,
					charOffset: 0,
				},
				{ resolveToken: async () => "secret-token", fetchImpl, ai },
			),
		).rejects.toThrow("2 MB");
	});

	it("refuses to fabricate page citations when conversion lacks page markers", () => {
		expect(() => splitPdfPages("No page boundaries")).toThrow(
			"no verifiable page boundaries",
		);
	});

	it("rejects a malformed bound file ID before resolving any credential", async () => {
		const resolveToken = vi.fn(async () => "secret-token");
		await expect(
			readWorkspaceDrivePdf(
				context,
				{
					resource: { ...resource, providerResourceId: ".." },
					requiredScopes: [],
					pageStart: 1,
					pageLimit: 1,
					charOffset: 0,
				},
				{ resolveToken, fetchImpl: providerFetch(), ai },
			),
		).rejects.toThrow("file ID is invalid");
		expect(resolveToken).not.toHaveBeenCalled();
	});

	it("returns a retrievable character offset for a long page", async () => {
		const longPageAi = {
			toMarkdown: vi.fn(async () => ({
				format: "markdown" as const,
				data: `## Contents\n### Page 1\n${"x".repeat(8_000)}`,
				tokens: 2_000,
			})),
		} as unknown as Pick<Ai, "toMarkdown">;
		const result = await readWorkspaceDrivePdf(
			context,
			{
				resource,
				requiredScopes: [],
				pageStart: 1,
				pageLimit: 1,
				charOffset: 0,
			},
			{
				resolveToken: async () => "secret-token",
				fetchImpl: providerFetch(),
				ai: longPageAi,
			},
		);
		expect(result.pages[0]).toMatchObject({
			page: 1,
			truncated: true,
			nextCharOffset: 7_000,
		});
		expect(result.pages[0]?.text).toHaveLength(7_000);
	});
});
