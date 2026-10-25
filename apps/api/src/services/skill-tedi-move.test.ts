import { describe, expect, it } from "vite-plus/test";
import {
	appAccessCheck,
	gatewayTediBridge,
	scheduleCheck,
	skillManifestNamespaces,
	skillNamespaceApps,
	skillRunGateway,
	sourceReferencesCheck,
	targetTediCheck,
	tediNamespaceCheck,
} from "./skill-tedi-move";

const gatewayApp = (slug: string, aggregateTedis: unknown[] = []) => ({
	id: `app-${slug}`,
	slug,
	metadata: {
		mcpConfig: {
			authMode: "authenticated",
			codeMode: true,
			aggregateApps: ["x"],
			aggregateTedis,
		},
	},
});

describe("skillRunGateway", () => {
	it("picks the authenticated Code Mode -unified gateway, like the skill runtime", () => {
		const other = gatewayApp("acme-tools");
		const unified = gatewayApp("acme-unified");
		const plain = { id: "a", slug: "firecrawl", metadata: {} };
		expect(skillRunGateway([plain, other, unified])).toBe(unified);
		expect(skillRunGateway([plain, other])).toBe(other);
		expect(skillRunGateway([plain])).toBeNull();
	});
});

describe("tedi namespace", () => {
	const doc = (mcp: string) =>
		`---\nname: x\ncapabilities:\n  mcp:\n${mcp}---\n# X\n`;

	it("reads the namespaces the manifest declares", () => {
		expect(
			skillManifestNamespaces(
				doc("    tedi:\n      - run_tedi_turn\n    os:\n      - read\n"),
			),
		).toEqual(["os", "tedi"]);
	});

	it("resolves the target's full bridge and its namespace", () => {
		const gateway = gatewayApp("acme-unified", [
			{ slug: "acme-operator", namespace: "operator" },
			{ slug: "reviewer", surface: "collaboration" },
		]);
		expect(gatewayTediBridge(gateway, "acme-operator")).toEqual({
			namespace: "operator",
		});
		expect(gatewayTediBridge(gateway, "reviewer")).toBeNull();
		expect(gatewayTediBridge(gateway, "missing")).toBeNull();
	});

	it("fails a skill that calls `tedi` when the target has no bridge", () => {
		const gateway = gatewayApp("acme-unified", [{ slug: "my-tedi" }]);
		const check = tediNamespaceCheck({
			namespaces: ["tedi"],
			gateway,
			target: { slug: "reddit-op" },
		});
		expect(check.status).toBe("fail");
		expect(check.detail).toContain("MCP_TARGET_UNRESOLVED");
		expect(check.detail).toContain('slug: "reddit-op"');
		expect(
			tediNamespaceCheck({
				namespaces: ["os"],
				gateway,
				target: { slug: "reddit-op" },
			}).status,
		).toBe("pass");
		expect(
			tediNamespaceCheck({
				namespaces: ["tedi"],
				gateway: gatewayApp("acme-unified", [{ slug: "reddit-op" }]),
				target: { slug: "reddit-op" },
			}).status,
		).toBe("pass");
	});
});

describe("app access", () => {
	const firecrawl = { id: "app-fc", slug: "firecrawl-acme" };
	const shop = { id: "app-shop", slug: "shop" };

	it("maps namespaces through bindings first, then slug candidates", () => {
		expect(
			skillNamespaceApps({
				namespaces: ["firecrawl_acme", "shop", "tedi", "unknown"],
				bindings: { firecrawl_acme: "app-fc" },
				orgApps: [firecrawl, shop],
			}),
		).toEqual([
			{ namespace: "firecrawl_acme", app: firecrawl },
			{ namespace: "shop", app: shop },
		]);
	});

	it("warns, never blocks, on an assignment the target lacks", () => {
		const reached = [{ namespace: "firecrawl_acme", app: firecrawl }];
		const gap = appAccessCheck({
			reached,
			sourceRoles: { "app-fc": "operator" },
			targetRoles: {},
		});
		expect(gap.status).toBe("warn");
		expect(gap.detail).toContain("firecrawl-acme");
		expect(
			appAccessCheck({
				reached,
				sourceRoles: { "app-fc": "operator" },
				targetRoles: { "app-fc": "operator" },
			}).status,
		).toBe("pass");
		expect(
			appAccessCheck({ reached, sourceRoles: null, targetRoles: null }).status,
		).toBe("warn");
	});
});

describe("other checks", () => {
	it("warns when the source names the current owner's id", () => {
		const check = sourceReferencesCheck({
			skill: {
				content: "reads mailbox",
				files: {
					"scripts/workflow.ts": 'const TEDI = "tedi-a"; use(TEDI, "tedi-a")',
				},
			},
			source: { id: "tedi-a", slug: "my-tedi" },
			targetName: "Operator",
		});
		expect(check.status).toBe("warn");
		expect(check.detail).toContain("2 time(s)");
	});

	it("refuses an inactive, retired or current owner", () => {
		const target = {
			id: "t",
			name: "Operator",
			status: "active" as const,
			retiredAt: null,
		};
		expect(targetTediCheck({ target, ownerTediId: "s" }).status).toBe("pass");
		expect(targetTediCheck({ target, ownerTediId: "t" }).status).toBe("fail");
		expect(
			targetTediCheck({
				target: { ...target, status: "paused" },
				ownerTediId: "s",
			}).status,
		).toBe("fail");
		expect(
			targetTediCheck({
				target: { ...target, retiredAt: "2026-01-01" },
				ownerTediId: "s",
			}).status,
		).toBe("fail");
	});

	it("flags a schedule that already names another tedi", () => {
		const schedule = {
			id: "s1",
			organizationId: "o",
			skillId: "k",
			tediId: "tedi-x",
			cron: "0 7 * * *",
			params: {},
			enabled: true,
			nextFireAt: "2026-10-26T07:00:00.000Z",
		};
		expect(scheduleCheck({ schedule, ownerTediId: "tedi-x" }).status).toBe(
			"pass",
		);
		expect(scheduleCheck({ schedule, ownerTediId: "tedi-a" }).status).toBe(
			"warn",
		);
		expect(
			scheduleCheck({ schedule: null, ownerTediId: "tedi-a" }).status,
		).toBe("pass");
	});
});
