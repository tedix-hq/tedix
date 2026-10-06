#!/usr/bin/env bun

/**
 * Provision Descope roles + permissions from the canonical RBAC model.
 *
 * The single source of truth is `@tedix/auth/rbac` (`ALL_PERMISSIONS`,
 * `ROLE_PERMISSION_GRANTS`). Historically these were hand-maintained in the
 * Descope Console and only mirrored in code; this script inverts that so the
 * Console is provisioned FROM code.
 *
 * Dry-run by default: it reads the live Descope state, prints the plan, and
 * exits WITHOUT mutating anything. Pass `--apply` to execute the plan. The plan
 * is superset-safe — it only creates missing permissions/roles and adds missing
 * grants (union), never deleting a role/permission or dropping a grant. See
 * `packages/auth/src/descope-rbac-sync.ts` for the diff/apply logic and tests.
 *
 * Usage:
 *   bun packages/auth/scripts/sync-descope-rbac.ts            # dry-run
 *   bun packages/auth/scripts/sync-descope-rbac.ts --apply    # execute
 *
 * Env: DESCOPE_PROJECT_ID (required), DESCOPE_MANAGEMENT_KEY (required to
 * apply), DESCOPE_BASE_URL (optional).
 */

import { createDescopeClient } from "@tedix/auth/descope";
import {
	applyDescopeRbacPlan,
	buildDescopeRbacPlan,
	type DescopeRbacManagementClient,
	type DescopeRbacReadClient,
	formatDescopeRbacPlan,
	planIsEmpty,
	readDescopeRbacSnapshot,
	summarizeDescopeRbacDrift,
} from "@tedix/auth/descope-rbac-sync";
import type { DescopeEnv } from "@tedix/auth/types";

function readEnv(): DescopeEnv {
	const projectId = process.env.DESCOPE_PROJECT_ID;
	if (!projectId) {
		throw new Error("Missing DESCOPE_PROJECT_ID environment variable");
	}
	return {
		DESCOPE_PROJECT_ID: projectId,
		DESCOPE_MANAGEMENT_KEY: process.env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: process.env.DESCOPE_BASE_URL,
	};
}

async function main(): Promise<void> {
	const apply = process.argv.includes("--apply");
	// `--check` turns the dry run into a GATE. Without it the script reports and
	// exits 0, which is right for a human reading a plan and wrong for CI, where
	// "Descope is missing what this commit defines" must fail the build.
	const check = process.argv.includes("--check");
	if (apply && check) {
		throw new Error(
			"--check is a dry-run gate and cannot be combined with --apply",
		);
	}
	const env = readEnv();

	if (apply && !env.DESCOPE_MANAGEMENT_KEY) {
		throw new Error("--apply requires DESCOPE_MANAGEMENT_KEY");
	}

	const client = createDescopeClient(env);

	// One reader, shared with the in-product drift surface. This used to be a
	// second hand-rolled copy here, which is exactly how the `permissionsNames`
	// alias bug reached the provisioning path.
	const snapshot = await readDescopeRbacSnapshot(
		client as unknown as DescopeRbacReadClient,
	);

	const plan = buildDescopeRbacPlan(snapshot);
	console.log(formatDescopeRbacPlan(plan));

	if (check) {
		// Only PROVISIONING drift fails. Description backfill is cosmetic and the
		// planner emits it for any permission Descope stored without one, so
		// gating on it would fail builds for something that changes no access.
		const summary = summarizeDescopeRbacDrift(plan, snapshot);
		if (summary.unusablePermissions.length > 0) {
			console.log(
				`\nNote: ${summary.unusablePermissions.length} permission(s) exist in Descope that no Tedix guard can evaluate: ${summary.unusablePermissions.join(", ")}. Not a failure — no sync can resolve them.`,
			);
		}
		if (summary.inSync) {
			console.log("\nDescope satisfies the model — nothing to provision.");
			return;
		}
		console.error(
			"\nDescope is missing part of the model this commit defines, so roles will not receive it.\n" +
				"Run `bun descope:rbac-sync:apply` (it only ever adds) and push again.",
		);
		process.exit(1);
	}

	if (planIsEmpty(plan)) return;

	if (!apply) {
		console.log(
			"\nDry-run — no changes applied. Re-run with --apply to provision Descope.",
		);
		return;
	}

	// Adapt the SDK client to the sync's narrow structural interface so the
	// mutation surface is explicit.
	const mgmt: DescopeRbacManagementClient = {
		management: {
			permission: {
				create: (name, description) =>
					client.management.permission.create(name, description),
				update: (name, newName, description) =>
					client.management.permission.update(name, newName, description),
			},
			role: {
				create: (name, description, permissionNames) =>
					client.management.role.create(name, description, permissionNames),
				update: (name, newName, description, permissionNames) =>
					client.management.role.update(
						name,
						newName,
						description,
						permissionNames,
					),
			},
		},
	};

	const result = await applyDescopeRbacPlan(mgmt, plan);
	console.log(
		`\nApplied ${result.appliedPermissionOps} permission op(s) and ${result.appliedRoleOps} role op(s).`,
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
