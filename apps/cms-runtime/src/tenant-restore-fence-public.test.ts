import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	CmsRestoreFenceUnavailableError,
	cmsRestoreFenceResponse,
	withCmsRestorePermit,
	withCmsRestoreResponsePermit,
} from "./tenant-restore-fence";

const db = {} as never;
const identity = { siteId: "site-public", slug: "public", restoreEpoch: 4 };

function fixture(enter = vi.fn().mockResolvedValue(true)) {
	const ledger = { enter, leave: vi.fn().mockResolvedValue(true) };
	const run = vi.fn(
		async () =>
			new Response("served", {
				headers: { "Content-Type": "text/html" },
			}),
	);
	const serve = async (request: Request) => {
		try {
			const result = await withCmsRestoreResponsePermit(
				db,
				identity,
				run,
				ledger,
				ledger,
				undefined,
				request,
			);
			return result.admitted ? result.value : cmsRestoreFenceResponse();
		} catch (error) {
			if (error instanceof CmsRestoreFenceUnavailableError)
				return cmsRestoreFenceResponse();
			throw error;
		}
	};
	return { ledger, run, serve };
}

afterEach(() => vi.restoreAllMocks());

describe("anonymous public restore ledger failures", () => {
	it("keeps an active fence closed with 503", async () => {
		const { serve, run } = fixture(vi.fn().mockResolvedValue(false));
		expect((await serve(new Request("https://site.example/blog"))).status).toBe(
			503,
		);
		expect(run).not.toHaveBeenCalled();
	});

	it("serves 200 when no fence is active", async () => {
		const { serve, ledger } = fixture();
		const response = await serve(new Request("https://site.example/blog"));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("served");
		expect(ledger.leave).toHaveBeenCalledOnce();
	});

	it.each(["GET", "HEAD"])(
		"serves anonymous %s when D1 throws and emits a warning metric",
		async (method) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { serve, ledger, run } = fixture(
				vi.fn().mockRejectedValue(new Error("D1 overloaded")),
			);
			ledger.leave.mockResolvedValue(false);
			expect(
				(await serve(new Request("https://site.example/blog", { method })))
					.status,
			).toBe(200);
			expect(run).toHaveBeenCalledOnce();
			expect(warning).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					metric: "cms_restore_fence_fail_open",
					value: 1,
					operation: "enter",
					...identity,
				}),
			);
			expect(ledger.leave).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["POST", "/blog", {}],
		["PUT", "/blog", {}],
		["PATCH", "/blog", {}],
		["DELETE", "/blog", {}],
		["GET", "/_emdash/admin", {}],
		["GET", "/_emdash", {}],
		["GET", "/admin", {}],
		["HEAD", "/api/read", {}],
		["GET", "/_tedix/internal/read", {}],
		["GET", "/%5Femdash/admin", {}],
		["GET", "/bad%encoding", {}],
		["GET", "/?_preview=1", {}],
		["GET", "/?_edit=1", {}],
		["GET", "/", { cookie: "session=fictional" }],
		["GET", "/", { authorization: "Bearer fictional" }],
		["GET", "/", { "x-tedix-cms-internal-auth": "fictional" }],
		["GET", "/", { "x-tedix-cms-human-assertion": "fictional" }],
		["GET", "/", { "x-tedix-cms-human-identity": "fictional" }],
		["GET", "/", { "x-tedix-cms-forwarded-user-auth": "fictional" }],
	] as const)(
		"keeps %s %s with %j closed on D1 errors",
		async (method, path, headers) => {
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { serve, run } = fixture(
				vi.fn().mockRejectedValue(new Error("D1 timeout")),
			);
			expect(
				(
					await serve(
						new Request(`https://site.example${path}`, { method, headers }),
					)
				).status,
			).toBe(503);
			expect(run).not.toHaveBeenCalled();
			expect(warning).not.toHaveBeenCalled();
		},
	);

	it("keeps nested writes closed even inside a fail-open public render", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { serve, ledger, run } = fixture(
			vi.fn().mockRejectedValue(new Error("D1 down")),
		);
		const write = vi.fn();
		run.mockImplementation(async () => {
			await withCmsRestorePermit(db, identity, write, ledger);
			return new Response("written");
		});
		expect((await serve(new Request("https://site.example/blog"))).status).toBe(
			503,
		);
		expect(write).not.toHaveBeenCalled();
	});

	it("does not replay a render when release throws", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { serve, ledger, run } = fixture();
		ledger.leave.mockRejectedValue(new Error("D1 timeout"));
		expect((await serve(new Request("https://site.example/blog"))).status).toBe(
			200,
		);
		expect(run).toHaveBeenCalledOnce();
		expect(warning).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ operation: "leave" }),
		);
	});

	it("fails closed on authenticated release errors", async () => {
		const { serve, ledger } = fixture();
		ledger.leave.mockRejectedValue(new Error("D1 timeout"));
		expect(
			(
				await serve(
					new Request("https://site.example/blog", {
						headers: { cookie: "session=fictional" },
					}),
				)
			).status,
		).toBe(503);
	});

	it("continues stream pulls on lookup errors but stops on an explicit closed fence", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { ledger, run, serve } = fixture();
		const cancel = vi.fn();
		run.mockImplementation(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							pull(controller) {
								controller.enqueue(new Uint8Array([1]));
							},
							cancel,
						},
						{ highWaterMark: 0 },
					),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		);
		const response = await serve(new Request("https://site.example/feed"));
		const reader = response.body!.getReader();
		ledger.enter.mockRejectedValueOnce(new Error("D1 down"));
		expect((await reader.read()).value).toEqual(new Uint8Array([1]));
		ledger.enter.mockResolvedValue(false);
		await expect(reader.read()).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(cancel).toHaveBeenCalledOnce();
	});
});
