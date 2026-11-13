import { describe, expect, it, vi } from "vite-plus/test";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import type { BaseContext } from "../rpc/orpc";
import {
	listWorkspaceDriveFiles,
	readWorkspaceDriveFile,
} from "./os-workspace-drive-read";

const context = { env: {} } as BaseContext;
const resource = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "org-example",
	providerId: "google-drive",
	providerResourceId: "folder-1",
	resourceType: "folder",
	connectionScope: "tenant",
	providerAccess: { canRead: true, canWrite: false },
} as OsWorkspaceResourceRow;
const file = {
	id: "file-1",
	name: "notes.txt",
	mimeType: "text/plain",
	parents: ["folder-1"],
	version: "7",
	modifiedTime: "2026-01-01T00:00:00Z",
};
const folder = {
	id: "folder-1",
	name: "Notes",
	mimeType: "application/vnd.google-apps.folder",
	version: "1",
};
const input = {
	resource,
	requiredScopes: [],
	fileId: "file-1",
	byteOffset: 0,
	byteLimit: 4,
};
const content = new TextEncoder().encode("hello world");
function provider(
	options: {
		metadata?: object;
		ignoreRange?: boolean;
		changed?: boolean;
		badRange?: boolean;
		moved?: boolean;
	} = {},
) {
	let reads = 0;
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
		expect(init?.redirect).toBe("error");
		const u = new URL(String(url));
		expect(u.origin).toBe("https://www.googleapis.com");
		if (u.pathname.endsWith("/export")) return new Response(content);
		if (u.searchParams.get("alt") === "media") {
			if (options.ignoreRange) return new Response(content);
			const range = /bytes=(\d+)-(\d+)/.exec(
				(init?.headers as Record<string, string>).Range,
			)!;
			const start = Number(range[1]),
				end = Math.min(Number(range[2]), content.length - 1);
			return new Response(content.slice(start, end + 1), {
				status: 206,
				headers: {
					"content-range": options.badRange
						? "bytes 9-10/11"
						: `bytes ${start}-${end}/${content.length}`,
				},
			});
		}
		if (u.pathname.endsWith("/files")) {
			expect(u.searchParams.get("q")).toBe(
				"'folder-1' in parents and trashed = false",
			);
			return Response.json({ files: [file], nextPageToken: "next-page" });
		}
		if (u.pathname.endsWith("/folder-1")) return Response.json(folder);
		reads++;
		return Response.json({
			...file,
			...options.metadata,
			...(options.changed && reads > 1 ? { version: "8" } : {}),
			...(options.moved && reads > 1 ? { parents: ["elsewhere"] } : {}),
		});
	}) as unknown as typeof fetch;
}
function deps(fetchImpl = provider()) {
	return { fetchImpl, resolveToken: async () => "test-token" };
}

describe("workspace Drive ranges and folders", () => {
	it("lists only the attached folder with bounded provider pagination", async () => {
		const fetchImpl = provider();
		const result = await listWorkspaceDriveFiles(
			context,
			{ resource, requiredScopes: [], limit: 25, pageToken: "previous" },
			deps(fetchImpl),
		);
		expect(result).toEqual({
			items: [
				{
					id: file.id,
					name: file.name,
					mimeType: file.mimeType,
					version: file.version,
					modifiedTime: file.modifiedTime,
				},
			],
			nextPageToken: "next-page",
		});
		const call = vi.mocked(fetchImpl).mock.calls[1]!;
		expect(new URL(String(call[0])).searchParams.get("pageToken")).toBe(
			"previous",
		);
	});
	it("reads a non-PDF in consecutive windows with revision checks", async () => {
		const fetchImpl = provider();
		const first = await readWorkspaceDriveFile(context, input, deps(fetchImpl));
		expect(atob(first.data)).toBe("hell");
		expect(first.nextByteOffset).toBe(4);
		const second = await readWorkspaceDriveFile(
			context,
			{
				...input,
				byteOffset: 4,
				byteLimit: 7,
				expectedVersion: first.file.version!,
			},
			deps(fetchImpl),
		);
		expect(atob(second.data)).toBe("o world");
		expect(second.nextByteOffset).toBeNull();
		expect(JSON.stringify(first)).not.toContain("test-token");
	});
	it("reads an exact attached file without widening the file ID", async () => {
		const result = await readWorkspaceDriveFile(
			context,
			{
				...input,
				resource: {
					...resource,
					resourceType: "file",
					providerResourceId: "file-1",
				},
			},
			deps(),
		);
		expect(atob(result.data)).toBe("hell");
	});
	it.each(["file", "folder"])(
		"rejects an outside file for a %s resource before media",
		async (resourceType) => {
			const fetchImpl = provider({ metadata: { parents: ["outside"] } });
			await expect(
				readWorkspaceDriveFile(
					context,
					{ ...input, resource: { ...resource, resourceType } },
					deps(fetchImpl),
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(
				vi
					.mocked(fetchImpl)
					.mock.calls.some((call) => String(call[0]).includes("alt=media")),
			).toBe(false);
		},
	);
	it("rejects a file moved out of the folder during a read", async () => {
		await expect(
			readWorkspaceDriveFile(context, input, deps(provider({ moved: true }))),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects a revision changed during a read", async () => {
		await expect(
			readWorkspaceDriveFile(context, input, deps(provider({ changed: true }))),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
	it("rejects a stale revision before downloading", async () => {
		const fetchImpl = provider();
		await expect(
			readWorkspaceDriveFile(
				context,
				{ ...input, expectedVersion: "old" },
				deps(fetchImpl),
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
	it("exports a native Google file and slices the requested window", async () => {
		const fetchImpl = provider({
			metadata: {
				mimeType: "application/vnd.google-apps.document",
				exportLinks: { "text/plain": "https://untrusted.example/export" },
			},
		});
		const result = await readWorkspaceDriveFile(
			context,
			{ ...input, byteOffset: 4 },
			deps(fetchImpl),
		);
		expect(atob(result.data)).toBe("o wo");
		expect(result.contentMimeType).toBe("text/plain");
		expect(result.nextByteOffset).toBe(8);
		expect(
			vi
				.mocked(fetchImpl)
				.mock.calls.some((call) =>
					String(call[0]).includes("/export?mimeType=text%2Fplain"),
				),
		).toBe(true);
	});
	it("rejects unsupported native exports without fabricating text", async () => {
		await expect(
			readWorkspaceDriveFile(
				context,
				input,
				deps(
					provider({
						metadata: { mimeType: "application/vnd.google-apps.shortcut" },
					}),
				),
			),
		).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
	});
	it("rejects an ignored nonzero byte range", async () => {
		await expect(
			readWorkspaceDriveFile(
				context,
				{ ...input, byteOffset: 4 },
				deps(provider({ ignoreRange: true })),
			),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
	});
	it("rejects a mismatched content range", async () => {
		await expect(
			readWorkspaceDriveFile(
				context,
				input,
				deps(provider({ badRange: true })),
			),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
	});
	it("returns binary bytes without lossy text conversion", async () => {
		const fetchImpl = provider();
		const binary = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) =>
				String(url).includes("alt=media")
					? new Response(new Uint8Array([0, 255, 128]))
					: fetchImpl(url, init),
		) as unknown as typeof fetch;
		const result = await readWorkspaceDriveFile(context, input, deps(binary));
		expect([...atob(result.data)].map((c) => c.charCodeAt(0))).toEqual([
			0, 255, 128,
		]);
	});
	it("refuses a disabled resource before credential resolution", async () => {
		const resolveToken = vi.fn();
		await expect(
			readWorkspaceDriveFile(
				context,
				{
					...input,
					resource: {
						...resource,
						providerAccess: { canRead: false, canWrite: false },
					},
				},
				{ resolveToken },
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(resolveToken).not.toHaveBeenCalled();
	});
	it("bounds a stalled metadata request", async () => {
		const fetchImpl = vi.fn(
			() => new Promise<Response>(() => {}),
		) as unknown as typeof fetch;
		await expect(
			readWorkspaceDriveFile(context, input, {
				...deps(fetchImpl),
				timeoutMs: 5,
			}),
		).rejects.toThrow("timed out");
	});
	it("cancels a stalled body", async () => {
		const cancel = vi.fn();
		const fetchImpl = provider();
		const stalled = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) =>
				String(url).includes("alt=media")
					? new Response(new ReadableStream({ cancel }))
					: fetchImpl(url, init),
		) as unknown as typeof fetch;
		await expect(
			readWorkspaceDriveFile(context, input, {
				...deps(stalled),
				timeoutMs: 5,
			}),
		).rejects.toThrow("timed out");
		expect(cancel).toHaveBeenCalled();
	});
});
