import { describe, expect, it } from "vite-plus/test";
import {
	handleMigrationProxy,
	isMigrationProxyPath,
	planMigrationProxy,
} from "./migration-proxy";

const ADMIN = ["platform:admin"];
const base = "https://tedix.mcp.example";

describe("planMigrationProxy", () => {
	it("forwards exactly the three route shapes for a platform admin", () => {
		expect(
			planMigrationProxy({
				method: "GET",
				pathname: "/admin/migration/workspaces/org/ws",
				scopes: ADMIN,
			}),
		).toEqual({
			kind: "forward",
			path: "/migration/workspaces/org/ws",
			method: "GET",
			shape: "describe",
		});
		expect(
			planMigrationProxy({
				method: "POST",
				pathname: "/admin/migration/workspaces/org/ws/import",
				scopes: ADMIN,
			}),
		).toMatchObject({
			kind: "forward",
			path: "/migration/workspaces/org/ws/import",
			shape: "import",
		});
		expect(
			planMigrationProxy({
				method: "POST",
				pathname: "/admin/migration/workspaces/org/ws/rows",
				scopes: ["*"],
			}),
		).toMatchObject({ kind: "forward", shape: "rows" });
	});

	it("refuses every other caller without detail", () => {
		for (const scopes of [
			undefined,
			[],
			["mcp:work.admin", "settings:admin"],
		]) {
			expect(
				planMigrationProxy({
					method: "GET",
					pathname: "/admin/migration/workspaces/org/ws",
					scopes,
				}),
			).toEqual({ kind: "forbidden" });
		}
	});

	it("rejects wrong methods and does not proxy unrelated or malformed paths", () => {
		expect(
			planMigrationProxy({
				method: "POST",
				pathname: "/admin/migration/workspaces/org/ws",
				scopes: ADMIN,
			}),
		).toEqual({ kind: "method_not_allowed" });
		expect(
			planMigrationProxy({
				method: "GET",
				pathname: "/admin/migration/workspaces/org/ws/import",
				scopes: ADMIN,
			}),
		).toEqual({ kind: "method_not_allowed" });
		for (const pathname of [
			"/admin/migration/workspaces/org/ws/delete",
			"/admin/migration/workspaces/org",
			"/admin/migration/workspaces/org/ws/rows/extra",
			"/migration/workspaces/org/ws",
			"/mcp",
		]) {
			expect(
				planMigrationProxy({ method: "GET", pathname, scopes: ADMIN }),
			).toEqual({ kind: "not_proxied" });
		}
		expect(isMigrationProxyPath("/admin/migration/workspaces/x/y")).toBe(true);
		expect(isMigrationProxyPath("/admin/other")).toBe(false);
	});
});

describe("handleMigrationProxy", () => {
	function env(seen: Request[]) {
		return {
			MIGRATE_WORKSPACES_TOKEN: "object-token",
			WORKSPACE_RUNTIME: {
				async fetch(request: Request) {
					seen.push(request);
					return Response.json({ ok: true, body: await request.text() });
				},
			},
		};
	}

	it("attaches the object bearer, keeps the body, and logs only shape, status and duration", async () => {
		const seen: Request[] = [];
		const logs: Record<string, string | number>[] = [];
		const response = await handleMigrationProxy(
			new Request(`${base}/admin/migration/workspaces/org/ws/import`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer caller-token",
				},
				body: JSON.stringify({ batchId: "b1", table: "os_outputs", rows: [] }),
			}),
			env(seen),
			ADMIN,
			(entry) => logs.push(entry),
		);
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		const forwarded = seen[0]!;
		expect(new URL(forwarded.url).pathname).toBe(
			"/migration/workspaces/org/ws/import",
		);
		expect(forwarded.headers.get("authorization")).toBe("Bearer object-token");
		expect(forwarded.headers.get("content-type")).toBe("application/json");
		expect((await response.json()) as { body: string }).toMatchObject({
			body: expect.stringContaining('"batchId":"b1"'),
		});
		expect(logs).toEqual([
			{ shape: "import", status: 200, durationMs: expect.any(Number) },
		]);
		expect(JSON.stringify(logs)).not.toContain("token");
	});

	it("answers 403 with no body to a non-admin and never touches the binding", async () => {
		const seen: Request[] = [];
		const response = await handleMigrationProxy(
			new Request(`${base}/admin/migration/workspaces/org/ws`),
			env(seen),
			["mcp:work.read"],
			() => {},
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("");
		expect(seen).toHaveLength(0);
	});

	it("answers 503 when the binding or the object token is missing", async () => {
		const response = await handleMigrationProxy(
			new Request(`${base}/admin/migration/workspaces/org/ws`),
			{ WORKSPACE_RUNTIME: undefined, MIGRATE_WORKSPACES_TOKEN: "x" },
			ADMIN,
			() => {},
		);
		expect(response.status).toBe(503);
	});

	it("does not proxy an unrelated path even for an admin", async () => {
		const seen: Request[] = [];
		const response = await handleMigrationProxy(
			new Request(`${base}/admin/other`),
			env(seen),
			ADMIN,
			() => {},
		);
		expect(response.status).toBe(404);
		expect(seen).toHaveLength(0);
	});
});
