import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	analyzeWorkerRoutes,
	effectiveProductionIngress,
	parseCloudflareIngressConfig,
	type SourceFile,
	validateWorkerIngressInventory,
	WORKER_APPS,
	WORKER_INGRESS_POLICY,
	type WorkerAppConfig,
} from "./lint-worker-route-authz.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Every app root that deploys a Worker through either supported config surface. */
function configuredWorkerApps(): string[] {
	return readdirSync(join(REPO_ROOT, "apps"))
		.filter((entry) =>
			["wrangler.jsonc", "cloudflare.config.ts"].some((config) =>
				existsSync(join(REPO_ROOT, "apps", entry, config)),
			),
		)
		.map((entry) => `apps/${entry}`)
		.sort();
}

const HONO_GUARDS: WorkerAppConfig["guards"] = {
	"\\bisServiceBinding\\s*\\(":
		"Test guard: service-binding-only routes for the fixture app.",
};

test("reads reviewed production ingress from cloudflare.config.ts", () => {
	expect(
		effectiveProductionIngress(
			parseCloudflareIngressConfig(`
				export const productionIngress = {
					workersDev: false,
					previewUrls: true,
				} as const;
			`),
		),
	).toEqual({ workersDev: false, previewUrls: true });
});

function honoApp(overrides: Partial<WorkerAppConfig> = {}): WorkerAppConfig {
	return { app: "apps/fixture", guards: HONO_GUARDS, ...overrides };
}

function file(path: string, lines: string[]): SourceFile {
	return { path, text: lines.join("\n") };
}

describe("Hono route model", () => {
	test("recognizes the portable snapshot HMAC guard on the API route", () => {
		const config = WORKER_APPS.find((app) => app.app === "apps/api");
		expect(config).toBeDefined();
		const guarded = analyzeWorkerRoutes(config!, [
			file("apps/api/src/worker-app.ts", [
				"const app = new Hono();",
				'app.get("/portable/tedis/:id/snapshot/:section", async (c) => {',
				"  const ticket = await verifyPortableSnapshotTicket({ token });",
				"  if (!ticket) return c.text('Unauthorized', 401);",
				"  return c.json({ rows: [] });",
				"});",
			]),
		]);
		expect(guarded.routes[0]?.classification).toBe("guarded");
		const missing = analyzeWorkerRoutes(config!, [
			file("apps/api/src/worker-app.ts", [
				"const app = new Hono();",
				'app.get("/portable/tedis/:id/snapshot/:section", (c) => c.json({ rows: [] }));',
			]),
		]);
		expect(missing.routes[0]?.classification).toBe("unguarded");
	});

	test("recognizes the portable import HMAC guard on the API route", () => {
		const config = WORKER_APPS.find((app) => app.app === "apps/api");
		expect(config).toBeDefined();
		const guarded = analyzeWorkerRoutes(config!, [
			file("apps/api/src/worker-app.ts", [
				"const app = new Hono();",
				'app.post("/portable/tedis/:id/import/:section", async (c) => {',
				"  const ticket = await verifyPortableImportTicket({ token });",
				"  if (!ticket) return c.text('Unauthorized', 401);",
				"  return c.json({ acceptedRows: 1 });",
				"});",
			]),
		]);
		expect(guarded.routes[0]?.classification).toBe("guarded");
		const missing = analyzeWorkerRoutes(config!, [
			file("apps/api/src/worker-app.ts", [
				"const app = new Hono();",
				'app.post("/portable/tedis/:id/import/:section", (c) => c.json({ acceptedRows: 1 }));',
			]),
		]);
		expect(missing.routes[0]?.classification).toBe("unguarded");
	});

	test("a route on a router with a guard middleware is guarded", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				'import { Hono } from "hono";',
				"const app = new Hono();",
				'app.use("*", async (c, next) => {',
				"\tif (!isServiceBinding(c.req.raw.headers)) return c.json({}, 401);",
				"\treturn next();",
				"});",
				'app.post("/run", async (c) => c.json({ ok: true }));',
			]),
		]);
		expect(routes).toHaveLength(1);
		expect(routes[0]?.classification).toBe("guarded");
		expect(routes[0]?.key).toBe("apps/fixture/src/index.ts::POST /run");
	});

	test("a route on an unguarded router is unguarded", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				'app.post("/run", async (c) => c.json({ ok: true }));',
			]),
		]);
		expect(routes[0]?.classification).toBe("unguarded");
	});

	test("a mounted child router inherits the parent guard across files", () => {
		// apps/tedi's exact shape: admin.use(isServiceBinding) in one file,
		// workstation routes in another, joined by admin.route(...).
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/admin.ts", [
				'import { workstation } from "./workstation";',
				"const admin = new Hono();",
				'admin.use("*", async (c, next) => {',
				"\tif (!isServiceBinding(c.req.raw.headers)) return c.json({}, 401);",
				"\treturn next();",
				"});",
				'admin.route("/workstation", workstation);',
			]),
			file("apps/fixture/src/workstation.ts", [
				"export const workstation = new Hono();",
				'workstation.post("/exec", async (c) => c.json({ ok: true }));',
			]),
		]);
		const exec = routes.find((route) => route.label === "POST /exec");
		expect(exec?.classification).toBe("guarded");
	});

	test("calls on non-router receivers are never routes", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				'const value = headers.get("host");',
				'cache.delete("key");',
			]),
		]);
		expect(routes).toEqual([]);
	});

	test("an authz: public annotation with a reason classifies as public", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				"// authz: public — unauthenticated liveness probe, no tenant data.",
				'app.get("/health", (c) => c.json({ ok: true }));',
			]),
		]);
		expect(routes[0]?.classification).toBe("public");
		expect(routes[0]?.publicReason).toContain("liveness probe");
	});

	test("a bare authz: public stamp without a reason does not classify", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				"// authz: public",
				'app.get("/health", (c) => c.json({ ok: true }));',
			]),
		]);
		expect(routes[0]?.classification).toBe("unguarded");
	});

	test("annotation wins over a router-level guard (skill-runtime /health)", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				'app.use("*", async (c, next) => {',
				'\tif (c.req.path === "/health") return next();',
				"\tif (!isServiceBinding(c.req.raw.headers)) return c.json({}, 401);",
				"\treturn next();",
				"});",
				"// authz: public — the gate above waves the health probe through.",
				'app.get("/health", (c) => c.json({ ok: true }));',
			]),
		]);
		expect(routes[0]?.classification).toBe("public");
	});

	test("captures Hono on registrations using the declared HTTP method", () => {
		const { routes } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				'app.use("*", async (c, next) => {',
				"\tif (!isServiceBinding(c.req.raw.headers)) return c.json({}, 401);",
				"\treturn next();",
				"});",
				'app.on("HEAD", "/preview/:id", (c) => c.body(null));',
			]),
		]);
		expect(routes[0]?.label).toBe("HEAD /preview/:id");
		expect(routes[0]?.classification).toBe("guarded");
	});
});

describe("pathname-branch model", () => {
	const PATH_GUARDS: WorkerAppConfig["guards"] = {
		"\\bwithBrokerApiSession\\s*\\(":
			"Test guard: requires the broker session cookie before proxying.",
	};

	function pathApp(): WorkerAppConfig {
		return {
			app: "apps/fixture",
			pathnameFiles: ["apps/fixture/src/worker.ts"],
			guards: PATH_GUARDS,
		};
	}

	test("a dispatch branch whose block shows a guard is guarded", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				"async function handle(request: Request) {",
				"\tconst url = new URL(request.url);",
				'\tif (url.pathname.startsWith("/api/")) {',
				"\t\tconst authenticated = withBrokerApiSession(request, COOKIE);",
				'\t\tif (!authenticated) return refuse(401, "no");',
				"\t\treturn proxy(authenticated);",
				"\t}",
				"}",
			]),
		]);
		expect(routes).toHaveLength(1);
		expect(routes[0]?.label).toBe("match /api/*");
		expect(routes[0]?.classification).toBe("guarded");
	});

	test("a dispatch branch without a guard is unguarded", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				'if (url.pathname === "/_preview") {',
				"\treturn handlePreview(request);",
				"}",
			]),
		]);
		expect(routes[0]?.key).toBe("apps/fixture/src/worker.ts::match /_preview");
		expect(routes[0]?.classification).toBe("unguarded");
	});

	test("assignment comparisons are not routes", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				'const isMcpPath = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");',
			]),
		]);
		expect(routes).toEqual([]);
	});

	test("predicate-helper return expressions are not routes", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				"function isOrpcTransportPath(pathname: string) {",
				"\treturn (",
				'\t\tpathname.startsWith("/api/rpc/") || pathname.startsWith("/cli/api/rpc/")',
				"\t);",
				"}",
			]),
		]);
		expect(routes).toEqual([]);
	});

	test("equality comparisons preceding the literal do not read as assignments", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				"if (",
				'\trequest.method === "OPTIONS" &&',
				'\turl.pathname === "/mcp"',
				") {",
				"\treturn preflight();",
				"}",
			]),
		]);
		expect(routes).toHaveLength(1);
		expect(routes[0]?.label).toBe("match /mcp");
	});

	test("occurrences of one literal merge, guarded when ANY branch guards", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				'if (url.pathname === "/mcp") {',
				"\treturn preflight();",
				"}",
				'if (url.pathname === "/mcp") {',
				"\tconst authenticated = withBrokerApiSession(request, COOKIE);",
				"\treturn dispatch(authenticated);",
				"}",
			]),
		]);
		expect(routes).toHaveLength(1);
		expect(routes[0]?.classification).toBe("guarded");
	});

	test("SCREAMING_CASE route constants are captured by name", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				"if (url.pathname === CAPN_ROUTE_PATH) {",
				"\treturn mount(request);",
				"}",
			]),
		]);
		expect(routes[0]?.label).toBe("match CAPN_ROUTE_PATH");
	});

	test("annotated single-statement branches classify as public", () => {
		const { routes } = analyzeWorkerRoutes(pathApp(), [
			file("apps/fixture/src/worker.ts", [
				"// authz: public — login-flow start endpoint, establishes the session.",
				"if (url.pathname !== `${prefix}/start`) return null;",
			]),
		]);
		expect(routes[0]?.label).toBe("match ${prefix}/start");
		expect(routes[0]?.classification).toBe("public");
	});

	test("a reviewed bounded prelude can carry an app-wide guard", () => {
		const config = pathApp();
		config.upstreamGuardWindowLines = 8;
		const { routes } = analyzeWorkerRoutes(config, [
			file("apps/fixture/src/worker.ts", [
				"const access = withBrokerApiSession(request, COOKIE);",
				"if (!access) return refuse(401);",
				'if (url.pathname === "/_preview") {',
				"\treturn preview(access);",
				"}",
			]),
		]);
		expect(routes[0]?.classification).toBe("guarded");
	});
});

describe("Worker ingress inventory", () => {
	test("applies Wrangler production inheritance and defaults", () => {
		expect(effectiveProductionIngress({})).toEqual({
			workersDev: true,
			previewUrls: true,
		});
		expect(
			effectiveProductionIngress({
				workers_dev: false,
				preview_urls: false,
				env: { production: { workers_dev: true, preview_urls: true } },
			}),
		).toEqual({ workersDev: true, previewUrls: true });
	});

	test("fails a service-only policy that exposes workers.dev", () => {
		const errors = validateWorkerIngressInventory(
			[
				{
					app: "apps/private",
					kind: "service-binding-only",
					workersDev: false,
					previewUrls: false,
					reason: "Private service-binding fixture with no public route.",
				},
			],
			new Map([["apps/private", {}]]),
		);
		expect(errors).toContain(
			"apps/private workers_dev is true, policy requires false",
		);
	});

	test("the reviewed production policy covers every configured Worker", () => {
		// Derived from apps/*/wrangler.jsonc rather than a count: adding or
		// retiring a Worker must be reflected in the reviewed policy, and a
		// count cannot tell a missing entry from a stale one.
		expect(WORKER_INGRESS_POLICY.map((entry) => entry.app).sort()).toEqual(
			configuredWorkerApps(),
		);
		expect(
			WORKER_INGRESS_POLICY.filter(
				(entry) => entry.kind === "service-binding-only",
			).every((entry) => !entry.workersDev && !entry.previewUrls),
		).toBe(true);
	});
});

describe("stale guard markers", () => {
	test("a marker that matches nowhere in the app is reported stale", () => {
		const { staleGuards } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", [
				"const app = new Hono();",
				'app.post("/run", async (c) => c.json({ ok: true }));',
			]),
		]);
		expect(staleGuards).toEqual(["\\bisServiceBinding\\s*\\("]);
	});

	test("a marker that matches is not stale", () => {
		const { staleGuards } = analyzeWorkerRoutes(honoApp(), [
			file("apps/fixture/src/index.ts", ["isServiceBinding(headers);"]),
		]);
		expect(staleGuards).toEqual([]);
	});
});

describe("configured app inventory", () => {
	test("covers the route-bearing Workers named by the expanded audit", () => {
		expect(WORKER_APPS.map((config) => config.app).sort()).toEqual([
			"apps/api",
			"apps/artifact-gateway",
			"apps/cms",
			"apps/cms-runtime",
			"apps/docs",
			"apps/docs-runtime",
			"apps/mcp",
			"apps/os",
			"apps/session-broker",
			"apps/skill-runtime",
			"apps/tedi",
			"apps/tedi-runtime",
			"apps/tedi-workstation-egress-broker",
			"apps/tedi-workstation-runtime",
			"apps/widget",
		]);
	});

	test("every configured guard marker carries a review reason", () => {
		for (const config of WORKER_APPS) {
			for (const [marker, reason] of Object.entries(config.guards)) {
				expect(marker.length).toBeGreaterThan(4);
				expect(reason.trim()).not.toBe("");
			}
		}
	});
});
