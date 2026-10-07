/**
 * The gate that makes "a Tedix OS verb shipped without audit" impossible.
 *
 * The original defect was not a bug in one handler — it was that emission was
 * optional, so five routers shipped with zero audit calls and every test still
 * passed. This walks the OS contracts themselves and forces a decision per
 * mutating verb: registered in `os-audit.ts`, or named in
 * `OS_AUDIT_NON_EMITTING` with a reason. It also enforces the split in the
 * other direction — a READ cannot be wired to emit, because a registry key
 * whose contract method is GET fails here.
 */

import { osApprovalRulesContract } from "@tedix/api-contract/contracts/os-approval-rules";
import { osComputeContract } from "@tedix/api-contract/contracts/os-compute";
import { osSharesContract } from "@tedix/api-contract/contracts/os-shares";
import { osTenantContract } from "@tedix/api-contract/contracts/os-tenant";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	lookupOsAuditSpecs,
	OS_APPROVAL_RULES_AUDIT,
	OS_AUDIT_NON_EMITTING,
	OS_SHARES_AUDIT,
	OS_WORKSPACES_AUDIT,
	type OsAuditRegistry,
	procedureMethod,
} from "./os-audit";

/** Every contract leaf as `dotted.path` -> declared HTTP method. */
function contractLeaves(
	node: unknown,
	prefix: string[] = [],
	found: Record<string, string> = {},
): Record<string, string> {
	if (typeof node !== "object" || node === null) return found;
	const method = procedureMethod(node);
	if (method !== undefined) {
		found[prefix.join(".")] = method;
		return found;
	}
	for (const [key, child] of Object.entries(node)) {
		if (key.startsWith("~")) continue;
		contractLeaves(child, [...prefix, key], found);
	}
	return found;
}

const DOMAINS: {
	name: string;
	contract: unknown;
	registry: OsAuditRegistry;
}[] = [
	{
		name: "osWorkspaces",
		contract: osWorkspacesContract,
		registry: OS_WORKSPACES_AUDIT,
	},
	{ name: "osShares", contract: osSharesContract, registry: OS_SHARES_AUDIT },
	{
		name: "osApprovalRules",
		contract: osApprovalRulesContract,
		registry: OS_APPROVAL_RULES_AUDIT,
	},
	// Enumerated even though neither declares an audited verb today. The gate's
	// whole promise is "an OS verb cannot ship un-audited", and a contract that
	// is absent from this list is exempt from that promise — which is exactly
	// how the original gap happened. `osCompute` is read-only and `osTenant`
	// carries one non-mutating POST; both are covered by
	// `OS_AUDIT_NON_EMITTING`, so adding a MUTATING verb to either now fails
	// this gate until it is registered or deliberately excused.
	{ name: "osCompute", contract: osComputeContract, registry: {} },
	{ name: "osTenant", contract: osTenantContract, registry: {} },
];

const READ_METHODS = new Set(["GET", "HEAD"]);

describe("Tedix OS audit coverage", () => {
	it("resolves every OS contract leaf to a declared HTTP method", () => {
		for (const domain of DOMAINS) {
			const leaves = contractLeaves(domain.contract);
			expect(Object.keys(leaves).length).toBeGreaterThan(0);
			for (const [path, method] of Object.entries(leaves)) {
				expect(`${domain.name}.${path}=${method}`).toMatch(
					/=(GET|POST|PUT|PATCH|DELETE)$/,
				);
			}
		}
	});

	it("forces every mutating verb to be registered or explicitly excused", () => {
		const undecided: string[] = [];
		for (const domain of DOMAINS) {
			for (const [path, method] of Object.entries(
				contractLeaves(domain.contract),
			)) {
				if (READ_METHODS.has(method)) continue;
				const registered =
					lookupOsAuditSpecs(domain.registry, path.split(".")).length > 0;
				const qualified = `${domain.name}.${path}`;
				if (!registered && OS_AUDIT_NON_EMITTING[qualified] === undefined) {
					undecided.push(`${domain.name}.${path} (${method})`);
				}
			}
		}
		expect(undecided).toEqual([]);
	});

	it("cannot wire a read: every registry key names a mutating contract leaf", () => {
		for (const domain of DOMAINS) {
			const leaves = contractLeaves(domain.contract);
			for (const key of Object.keys(domain.registry)) {
				const method = leaves[key];
				expect(
					method,
					`${domain.name}.${key} names no contract leaf`,
				).toBeDefined();
				expect(
					READ_METHODS.has(method as string),
					`${domain.name}.${key} is a read (${method}) and must not emit`,
				).toBe(false);
			}
		}
	});

	it("keeps the non-emitting allowlist honest", () => {
		const known = new Set(
			DOMAINS.flatMap((domain) =>
				Object.keys(contractLeaves(domain.contract)).map(
					(path) => `${domain.name}.${path}`,
				),
			),
		);
		for (const [path, reason] of Object.entries(OS_AUDIT_NON_EMITTING)) {
			expect(known.has(path), `${path} is not an OS contract leaf`).toBe(true);
			expect(reason.length).toBeGreaterThan(8);
			// An excused verb must not also be registered.
			for (const domain of DOMAINS) {
				expect(
					lookupOsAuditSpecs(domain.registry, path.split(".")).length,
				).toBe(0);
			}
		}
	});

	it("covers every scoped lifecycle verb", () => {
		const required = [
			"workspaces.create",
			"workspaces.update",
			"workspaces.archive",
			"workspaces.restore",
			"workspaces.decideBlueprintUpgrade",
			"resources.startRepositoryWork",
			"gadgets.create",
			"gadgets.revise",
			"gadgets.archive",
			"gadgets.delete",
			"outputs.create",
			"outputs.revise",
			"outputs.rename",
			"outputs.archive",
			"outputs.patchDocument",
			"outputs.setSheetRange",
			"blueprints.create",
			"blueprints.revise",
			"blueprints.publish",
			"blueprints.setVisibility",
			"blueprints.instantiate",
			"blueprints.instantiateFromGallery",
			"blueprints.import",
			"collaboration.create",
			"collaboration.accept",
			"collaboration.reject",
			"collaboration.merge",
		];
		for (const path of required) {
			expect(
				lookupOsAuditSpecs(OS_WORKSPACES_AUDIT, path.split(".")).length,
				path,
			).toBeGreaterThan(0);
		}
		for (const path of ["shares.create", "shares.restrict", "shares.revoke"]) {
			expect(
				lookupOsAuditSpecs(OS_SHARES_AUDIT, path.split(".")).length,
				path,
			).toBeGreaterThan(0);
		}
		for (const path of ["create", "setEnabled", "apply"]) {
			expect(
				lookupOsAuditSpecs(OS_APPROVAL_RULES_AUDIT, [path]).length,
				path,
			).toBeGreaterThan(0);
		}
	});

	it("matches a namespaced path and a bare router-client path identically", () => {
		expect(
			lookupOsAuditSpecs(OS_WORKSPACES_AUDIT, [
				"osWorkspaces",
				"workspaces",
				"create",
			])[0]?.action,
		).toBe("os.workspace.created");
		expect(
			lookupOsAuditSpecs(OS_WORKSPACES_AUDIT, ["workspaces", "create"])[0]
				?.action,
		).toBe("os.workspace.created");
		expect(lookupOsAuditSpecs(OS_WORKSPACES_AUDIT, [])).toEqual([]);
	});

	it("audits repository preparation against its canonical Work Item without prompt content", () => {
		const [spec] = lookupOsAuditSpecs(OS_WORKSPACES_AUDIT, [
			"resources",
			"startRepositoryWork",
		]);
		const frame = {
			input: {
				workspaceId: "workspace-1",
				resourceId: "resource-1",
				projectId: "project-1",
				tediId: "tedi-1",
				task: "sensitive task text",
				outcome: "sensitive outcome text",
			},
			output: { workItemId: "work-item-1" },
		};

		expect(spec).toMatchObject({
			action: "os.workspace_repository_work.prepared",
			resourceType: "work_item",
		});
		expect(spec?.resourceId(frame)).toBe("work-item-1");
		expect(spec?.metadata?.(frame)).toEqual({
			workspaceId: "workspace-1",
			workspaceResourceId: "resource-1",
			projectId: "project-1",
			tediId: "tedi-1",
		});
		expect(JSON.stringify(spec?.metadata?.(frame))).not.toContain("sensitive");
	});

	it("emits one approval-rule row per matched rule and none for an empty sweep", () => {
		const [spec] = lookupOsAuditSpecs(OS_APPROVAL_RULES_AUDIT, ["apply"]);
		expect(spec?.action).toBe("os.approval_rule.applied");
		expect(
			spec?.resourceId({
				input: {},
				output: {
					resolved: 3,
					ruleMatches: [
						{ approvalId: "a1", ruleId: "rule-1" },
						{ approvalId: "a2", ruleId: "rule-1" },
						{ approvalId: "a3", ruleId: "rule-2" },
					],
				},
			}),
		).toEqual(["rule-1", "rule-2"]);
		expect(
			spec?.resourceId({ input: {}, output: { resolved: 0, ruleMatches: [] } }),
		).toEqual([]);
	});
});
