import { describe, expect, it } from "vite-plus/test";
import {
	DOCS_PREVIEW_ROBOTS_POLICY,
	rewritePreviewHtml,
	withDocsPreviewRobotsPolicy,
} from "./preview";
import {
	authorizePreviewAccess,
	createPreviewAccess,
	previewAccessOrg,
} from "./preview-access";
import type { AppBindings } from "./types";

function env(): AppBindings {
	return {
		DOCS_ADMIN_URL: "https://docs-admin.tedix.dev",
		PLATFORM_SERVICE_TOKEN: "preview-test-secret",
	} as AppBindings;
}

describe("Docs preview access", () => {
	it("creates a short-lived tenant and build-bound link", async () => {
		const access = await createPreviewAccess({
			buildId: "11111111-1111-4111-8111-111111111111",
			env: env(),
			orgSlug: "tedix",
		});
		const request = new Request(access.previewUrl);

		const authorized = await authorizePreviewAccess({
			buildId: "11111111-1111-4111-8111-111111111111",
			env: env(),
			orgSlug: "tedix",
			request,
		});

		expect(authorized?.setCookie).toContain("tedix_docs_preview=");
		expect(authorized?.setCookie).toContain("HttpOnly");
		const cookie = authorized?.setCookie?.split(";")[0];
		const assetRequest = new Request(
			"https://docs-admin.tedix.dev/preview/11111111-1111-4111-8111-111111111111/_astro/main.css",
			{ headers: { Cookie: cookie ?? "" } },
		);
		expect(previewAccessOrg(assetRequest)).toBe("tedix");
		await expect(
			authorizePreviewAccess({
				buildId: "11111111-1111-4111-8111-111111111111",
				env: env(),
				orgSlug: "tedix",
				request: assetRequest,
			}),
		).resolves.toEqual({ setCookie: null });
	});

	it("rejects a link replayed for another tenant or build", async () => {
		const access = await createPreviewAccess({
			buildId: "11111111-1111-4111-8111-111111111111",
			env: env(),
			orgSlug: "tedix",
		});

		await expect(
			authorizePreviewAccess({
				buildId: "22222222-2222-4222-8222-222222222222",
				env: env(),
				orgSlug: "other",
				request: new Request(access.previewUrl),
			}),
		).resolves.toBeNull();
	});

	it("rewrites root-relative Nimbus assets and navigation into the preview", () => {
		const html =
			'<link href="/_astro/main.css"><a href="/guide">Guide</a><a href="https://docs.tedix.dev">Live</a>';

		expect(rewritePreviewHtml(html, "build-1")).toBe(
			'<link href="/preview/build-1/_astro/main.css"><a href="/preview/build-1/guide">Guide</a><a href="https://docs.tedix.dev">Live</a>',
		);
	});

	it("marks every preview outcome private to search crawlers", async () => {
		const response = withDocsPreviewRobotsPolicy(
			new Response("Documentation preview not found", { status: 404 }),
		);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Documentation preview not found");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			DOCS_PREVIEW_ROBOTS_POLICY,
		);
	});
});
