import { describe, expect, it, vi } from "vite-plus/test";
import { checkLiveThemeCompatibility } from "./theme-content-compatibility";
import type { AppBindings } from "../types";
import type { ThemeRelease } from "./theme-release";

const release: ThemeRelease = {
	version: 1,
	templateSlug: "marketing",
	upstreamStarterRevision: "a".repeat(40),
	lockedTemplateSnapshotHash: "b".repeat(64),
	dependencyLockHash: "c".repeat(64),
	supportedBlocks: { hero: [1] },
};
function fixture(lastBlock = { _type: "hero", _version: 1 }) {
	const urls: URL[] = [];
	const fetch = vi.fn(async (request: Request) => {
		const url = new URL(request.url);
		urls.push(url);
		expect(request.headers.get("X-Tedix-CMS-Internal-Auth")).toBe("internal");
		const data = url.pathname.endsWith("/schema/collections")
			? { items: [{ slug: "pages" }, { slug: "posts" }] }
			: url.pathname.endsWith("/posts")
				? { items: [] }
				: url.searchParams.has("cursor")
					? { items: [{ data: { content: [lastBlock], locale: "de" } }] }
					: {
							items: [{ data: { content: [{ _type: "hero", _version: 1 }] } }],
							nextCursor: "page-2",
						};
		return Response.json({ success: true, data });
	});
	const env = {
		CMS_DISPATCH: { fetch },
		CMS_INTERNAL_AUTH_TOKEN: "internal",
		ENVIRONMENT: "production",
	} as unknown as AppBindings;
	return { env, urls, fetch };
}
describe("published native content compatibility", () => {
	it("checks every collection and page without filtering locales", async () => {
		const { env, urls } = fixture();
		await checkLiveThemeCompatibility(env, "site-a", release);
		expect(urls).toHaveLength(4);
		expect(urls[2]!.searchParams.get("cursor")).toBe("page-2");
		for (const url of urls.slice(1)) {
			expect(url.searchParams.get("status")).toBe("published");
			expect(url.searchParams.has("locale")).toBe(false);
		}
	});
	it.each([
		{ _type: "missing", _version: 1 },
		{ _type: "hero", _version: 2 },
	])("refuses a later-page incompatible block %j", async (block) => {
		const { env } = fixture(block);
		await expect(
			checkLiveThemeCompatibility(env, "site-a", release),
		).rejects.toMatchObject({
			code: "THEME_BLOCK_UNSUPPORTED",
			retryable: false,
		});
	});
	it.each(["denied", "malformed", "loop", "network"])(
		"fails closed for %s",
		async (fault) => {
			const { env, fetch } = fixture();
			fetch.mockImplementation(async () => {
				if (fault === "network") throw new Error("unreachable");
				if (fault === "denied") return new Response("denied", { status: 403 });
				if (fault === "loop")
					return Response.json({
						success: true,
						data: { items: [{ slug: "pages", data: {} }], nextCursor: "same" },
					});
				return Response.json({ success: true, data: {} });
			});
			await expect(
				checkLiveThemeCompatibility(env, "site-a", release),
			).rejects.toMatchObject({
				code: "THEME_CONTENT_UNAVAILABLE",
				retryable: false,
			});
		},
	);
});
