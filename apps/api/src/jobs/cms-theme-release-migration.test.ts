import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { listActiveCmsSitesForThemeReleaseMigration } from "@tedix/db/queries/cms-sites";
import { runCmsThemeReleaseMigrationTick } from "./cms-theme-release-migration";

vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	listActiveCmsSitesForThemeReleaseMigration: vi.fn(),
}));
const hash = "a".repeat(40);
const sites = [
	{ id: "site-a", slug: "acme" },
	{ id: "site-b", slug: "other" },
];
function fixture() {
	let cursor = "";
	const fetch = vi.fn(async (request: Request) =>
		Response.json({
			orgSlug: request.headers.get("X-Tedix-Connection-Label"),
			status: "committed",
			sourceCommit: hash,
			migrationCommit: hash,
		}),
	);
	const put = vi.fn(async (_key: string, value: string) => {
		cursor = value;
	});
	const env = {
		DB: {},
		CMS: { fetch },
		PLATFORM_SERVICE_TOKEN: "private-token",
		R2_BUCKET: { get: vi.fn(async () => ({ text: async () => cursor })), put },
	} as unknown as Parameters<typeof runCmsThemeReleaseMigrationTick>[0];
	return { env, fetch, put };
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listActiveCmsSitesForThemeReleaseMigration).mockResolvedValue(
		sites,
	);
	vi.spyOn(console, "log").mockImplementation(() => {});
});
describe("scheduled theme release migration", () => {
	it("calls every site with scoped service auth and logs only validated receipts", async () => {
		const f = fixture();
		expect(await runCmsThemeReleaseMigrationTick(f.env)).toEqual({
			checked: 2,
			present: 2,
			running: 0,
			failed: 0,
		});
		for (const [index, [request]] of f.fetch.mock.calls.entries()) {
			expect(request.method).toBe("POST");
			expect(request.url).toBe(
				`https://cms.internal/api/internal/deployments/${sites[index]!.slug}/theme-release-migration`,
			);
			expect(request.headers.get("Authorization")).toBe("Bearer private-token");
			expect(request.headers.get("X-Tedix-Connection-Label")).toBe(
				sites[index]!.slug,
			);
		}
		expect(console.log).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
			"private-token",
		);
	});
	it("probes running jobs on the next sweep without polling in a tick", async () => {
		const f = fixture();
		f.fetch.mockResolvedValueOnce(
			Response.json(
				{ orgSlug: "acme", status: "running", jobId: "job-a" },
				{ status: 202 },
			),
		);
		expect(await runCmsThemeReleaseMigrationTick(f.env)).toMatchObject({
			running: 1,
			present: 1,
		});
		await runCmsThemeReleaseMigrationTick(f.env);
		expect(f.fetch).toHaveBeenCalledTimes(4);
	});
	it.each([
		"network",
		"wrong-site",
		"missing-commit",
		"http-error",
		"failed",
		"invalid-json",
	])("records %s and continues to the next site", async (fault) => {
		const f = fixture();
		if (fault === "network") f.fetch.mockRejectedValueOnce(new Error("secret"));
		else if (fault === "invalid-json")
			f.fetch.mockResolvedValueOnce(new Response("secret"));
		else
			f.fetch.mockResolvedValueOnce(
				Response.json(
					{
						orgSlug: fault === "wrong-site" ? "foreign" : "acme",
						status: fault === "failed" ? "failed" : "committed",
						sourceCommit: fault === "missing-commit" ? undefined : hash,
						code: fault === "failed" ? "HEAD_CONFLICT" : undefined,
						token: "secret",
					},
					{ status: fault === "http-error" || fault === "failed" ? 500 : 200 },
				),
			);
		expect(await runCmsThemeReleaseMigrationTick(f.env)).toEqual({
			checked: 2,
			present: 1,
			running: 0,
			failed: 1,
		});
		expect(f.fetch).toHaveBeenCalledTimes(2);
		expect(console.log).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
			"secret",
		);
	});
	it("advances a full page and wraps at the end of the fleet", async () => {
		const f = fixture();
		const page = Array.from({ length: 10 }, (_, i) => ({
			id: `id-${i}`,
			slug: `slug-${i}`,
		}));
		vi.mocked(listActiveCmsSitesForThemeReleaseMigration)
			.mockResolvedValueOnce(page)
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(sites);
		await runCmsThemeReleaseMigrationTick(f.env);
		await runCmsThemeReleaseMigrationTick(f.env);
		await runCmsThemeReleaseMigrationTick(f.env);
		expect(
			vi
				.mocked(listActiveCmsSitesForThemeReleaseMigration)
				.mock.calls.map((call) => call[1]),
		).toEqual(["", "id-9", ""]);
	});
});
