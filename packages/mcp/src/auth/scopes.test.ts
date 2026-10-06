import { describe, expect, it } from "vite-plus/test";

// Relative source import (test-only) to guard cross-package drift without
// coupling the runtime dependency graph. The api-contract map is the
// human-facing mirror of the enforcement-side CAPABILITY_SCOPES list.
import { MCP_GRANULAR_CAPABILITY_SCOPES } from "../../../api-contract/src/schemas/mcp-capability-scopes";
import {
	CAPABILITY_PROFILES,
	CAPABILITY_SCOPES,
	DEFAULT_TEDI_SCOPES,
	delegatedMachineScopes,
	hasAllScopes,
	hasScope,
	isTediMcpToolReadOnly,
	requiredTediMcpToolScope,
	resolveTediScopes,
} from "./scopes";

describe("MCP scope implication", () => {
	it("maps direct-tedi tools to least-privilege category scopes", () => {
		expect(requiredTediMcpToolScope("messages_read")).toBe("tedi:channel.read");
		expect(requiredTediMcpToolScope("run_tedi_turn")).toBe(
			"tedi:channel.write",
		);
		expect(requiredTediMcpToolScope("exec")).toBe("tedi:permissions.write");
		expect(isTediMcpToolReadOnly("artifact_read_file")).toBe(true);
	});
	it("keeps platform authority separate from MCP capabilities", () => {
		expect(hasScope(["*"], "mcp:apps.read")).toBe(true);
		expect(hasScope(["mcp:*"], "mcp:apps.read")).toBe(true);
		expect(hasScope(["platform:admin"], "mcp:apps.admin")).toBe(false);
		expect(hasScope(["mcp:*"], "tedi:brain.read")).toBe(false);
		expect(hasScope(["tedi:*"], "tedi:email.read")).toBe(true);
		expect(hasScope(["tedi:admin"], "tedi:email.write")).toBe(true);
		expect(hasScope(["tedi:browser"], "tedi:browser.write")).toBe(true);
	});

	it("rejects removed broad MCP capability grants", () => {
		expect(hasScope(["mcp:apps"], "mcp:apps.read")).toBe(false);
		expect(hasScope(["mcp:apps"], "mcp:apps.write")).toBe(false);
		expect(hasScope(["mcp:apps"], "mcp:apps.admin")).toBe(false);
		expect(hasScope(["mcp:skills"], "mcp:skills.write")).toBe(false);
		expect(hasScope(["mcp:catalog"], "mcp:apps.read")).toBe(false);
		expect(hasScope(["tedi:email"], "tedi:email.read")).toBe(true);
		expect(hasScope(["tedi:brain"], "tedi:email.read")).toBe(false);
	});

	it("applies implication when enforcing multiple scopes", () => {
		expect(
			hasAllScopes(
				["mcp:apps.write", "mcp:observe.read"],
				["mcp:apps.write", "mcp:observe.read"],
			),
		).toBe(true);
	});

	it("grants skills to standard tedi identities without admin/settings", () => {
		expect(DEFAULT_TEDI_SCOPES).toContain("mcp:skills.read");
		expect(DEFAULT_TEDI_SCOPES).toContain("mcp:skills.write");
		expect(DEFAULT_TEDI_SCOPES).not.toContain("mcp:skills.admin");
		expect(DEFAULT_TEDI_SCOPES).not.toContain("platform:admin");
		expect(DEFAULT_TEDI_SCOPES).not.toContain("mcp:settings.read");
	});
});

describe("capability-scope vocabulary parity", () => {
	// Two hand-maintained lists exist: the enforcement-side CAPABILITY_SCOPES
	// (@tedix/mcp-shared) and the registration/description-side
	// MCP_CAPABILITY_SCOPES (@tedix/api-contract). They MUST stay identical in
	// membership; nothing at runtime couples them, so this test is the guard.
	it("keeps CAPABILITY_SCOPES identical to the granular catalog", () => {
		expect([...CAPABILITY_SCOPES].sort()).toEqual(
			Object.keys(MCP_GRANULAR_CAPABILITY_SCOPES).sort(),
		);
	});
});

describe("content_admin capability profile", () => {
	// The marketing owner: a standard worker plus CMS/docs administration only.
	it("adds exactly mcp:content.admin to standard", () => {
		const standard = resolveTediScopes("standard");
		const extra = resolveTediScopes("content_admin").filter(
			(s) => !standard.includes(s),
		);
		expect(extra).toEqual(["mcp:content.admin"]);
	});

	it("withholds settings, member, tedi and platform administration", () => {
		const scopes = resolveTediScopes("content_admin");
		for (const withheld of [
			"mcp:settings.admin",
			"mcp:tedis.admin",
			"mcp:apps.admin",
			"connections.admin",
			"platform:admin",
		]) {
			expect(scopes).not.toContain(withheld);
		}
	});
});

describe("org_admin capability profile", () => {
	// The tenant operator: everything a standard tedi has PLUS mcp:settings
	// (own-org governance), but NOT platform:admin (platform-wide/cross-org).
	it("grants granular settings scopes but withholds platform:admin", () => {
		const scopes = resolveTediScopes("org_admin");
		expect(scopes).toContain("mcp:settings.admin");
		expect(scopes).toContain("mcp:apps.write");
		expect(scopes).not.toContain("platform:admin");
		expect(scopes).toContain("connections.execute");
		expect(scopes).toContain("connections.admin");
	});

	it("is a strict superset of standard", () => {
		const orgAdmin = CAPABILITY_PROFILES.org_admin as readonly string[];
		for (const s of CAPABILITY_PROFILES.standard as readonly string[]) {
			expect(orgAdmin).toContain(s);
		}
		// ...and the only thing platform_admin adds over org_admin is platform:admin.
		const extra = resolveTediScopes("platform_admin").filter(
			(s) => !resolveTediScopes("org_admin").includes(s),
		);
		expect(extra).toEqual(["platform:admin"]);
	});

	it("is NOT a platform principal — cannot satisfy a bare platform:admin gate", () => {
		// org_admin holds no platform:admin and no wildcard, so a tool that genuinely
		// requires platform:admin (waitlist.*, tenantMembership.*) stays out of reach.
		expect(
			hasScope([...resolveTediScopes("org_admin")], "platform:admin"),
		).toBe(false);
	});
});

describe("delegatedMachineScopes (MCP → machine vocabulary bridge)", () => {
	it("translates granular capability scopes to machine scopes", () => {
		expect(
			delegatedMachineScopes(["mcp:tedis.read", "mcp:apps.write"]),
		).toEqual(["apps:write", "tedis:read", "tools:write"]);
		expect(delegatedMachineScopes(["mcp:settings.write"])).toEqual([
			"billing:read",
			"billing:write",
		]);
	});

	it("does not turn platform authority into tenant machine capabilities", () => {
		const expanded = delegatedMachineScopes(["platform:admin"]);
		expect(expanded).toEqual([]);
	});

	it("ignores tool scopes, unknown domains, and removed MCP wildcards", () => {
		expect(
			delegatedMachineScopes([
				"mcp:list.work.items",
				"mcp:unknowndomain.read",
				"tedi:channel.read",
				"profile",
			]),
		).toEqual([]);
		expect(delegatedMachineScopes(["mcp:*"])).toEqual([]);
	});

	it("dedupes repeated grants", () => {
		expect(
			delegatedMachineScopes(["mcp:tedis.read", "mcp:tedis.read"]),
		).toEqual(["tedis:read"]);
	});
});

describe("connected provider read authority", () => {
	it("keeps provider read a subset of execute without granting writes or admin", () => {
		expect(hasScope(["connections.read"], "connections.read")).toBe(true);
		expect(hasScope(["connections.execute"], "connections.read")).toBe(true);
		expect(hasScope(["connections.read"], "connections.execute")).toBe(false);
		expect(hasScope(["connections.read"], "connections.admin")).toBe(false);
		expect(hasScope(["connections.admin"], "connections.read")).toBe(false);
		expect(hasScope(["platform:admin"], "connections.read")).toBe(false);
	});
});
