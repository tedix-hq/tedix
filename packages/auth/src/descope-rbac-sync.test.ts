import { describe, expect, it } from "vite-plus/test";
import {
	applyDescopeRbacPlan,
	buildDescopeRbacPlan,
	type DescopeRbacManagementClient,
	type DescopeRbacSnapshot,
	type DescopeSdkResult,
	describePermission,
	formatDescopeRbacPlan,
	planIsEmpty,
	planPermissionSync,
	planRoleSync,
	readDescopeRbacSnapshot,
	readDescopeRolePermissionNames,
	summarizeDescopeRbacDrift,
} from "./descope-rbac-sync";
import {
	ALL_PERMISSIONS,
	DESCOPE_BUILT_IN_PERMISSIONS,
	findUnusableDescopePermissions,
	ROLE_PERMISSION_GRANTS,
} from "./rbac";

/** A snapshot that fully satisfies the canonical model. */
function inSyncSnapshot(): DescopeRbacSnapshot {
	return {
		permissions: ALL_PERMISSIONS.map((name) => ({
			name,
			description: describePermission(name),
		})),
		roles: Object.entries(ROLE_PERMISSION_GRANTS).map(([name, grants]) => ({
			name,
			description: `human-authored ${name}`,
			permissionNames: [
				...grants,
				...(["owner", "admin"].includes(name)
					? ["User Admin", "SSO Admin"]
					: []),
			],
		})),
	};
}

describe("planPermissionSync", () => {
	it("creates every canonical permission against an empty project", () => {
		const ops = planPermissionSync([]);
		expect(ops).toHaveLength(ALL_PERMISSIONS.length);
		expect(ops.every((op) => op.kind === "create-permission")).toBe(true);
		expect(new Set(ops.map((op) => op.name))).toEqual(new Set(ALL_PERMISSIONS));
	});

	it("fills in a description only where Descope has none", () => {
		const existing = ALL_PERMISSIONS.map((name, i) => ({
			name,
			// Give even-indexed permissions a human description, blank the rest.
			description: i % 2 === 0 ? "human" : "",
		}));
		const ops = planPermissionSync(existing);
		expect(ops.every((op) => op.kind === "describe-permission")).toBe(true);
		// Only the blank ones get an op; the human-described ones are left alone.
		const blanks = existing.filter((p) => p.description === "").length;
		expect(ops).toHaveLength(blanks);
	});

	it("never overwrites an existing non-empty description", () => {
		const existing = ALL_PERMISSIONS.map((name) => ({
			name,
			description: "console-authored",
		}));
		expect(planPermissionSync(existing)).toHaveLength(0);
	});
});

describe("planRoleSync", () => {
	it("creates every canonical role against an empty project", () => {
		const ops = planRoleSync([]);
		expect(new Set(ops.map((op) => op.name))).toEqual(
			new Set(Object.keys(ROLE_PERMISSION_GRANTS)),
		);
		expect(ops.every((op) => op.kind === "create-role")).toBe(true);
	});

	it("adds canonical grants without removing console grants", () => {
		// Descope already grants `admin` a hand-added permission the model does
		// not know about, and is missing one the model DOES grant.
		const modelAdmin = [...ROLE_PERMISSION_GRANTS.admin];
		const hangOn = "custom:legacy-grant";
		const existing = [
			{
				name: "admin",
				description: "human admin",
				permissionNames: [
					hangOn,
					...modelAdmin.filter((p) => p !== "apps:delete"),
				],
			},
		];
		const ops = planRoleSync(existing, { admin: modelAdmin });
		expect(ops).toHaveLength(1);
		const [op] = ops;
		if (!op || op.kind !== "update-role-permissions") {
			throw new Error("expected grant op");
		}
		expect(op.permissionNames).toContain(hangOn);
		// The missing model grant is added.
		expect(op.addedPermissions).toEqual(["apps:delete"]);
		expect(op.permissionNames).toContain("apps:delete");
		// Description is preserved, not clobbered.
		expect(op.description).toBe("human admin");
	});

	it("ignores console-only grants when every desired grant is present", () => {
		const existing = [
			{
				name: "admin",
				description: "human admin",
				// Extra grants beyond the model must not trigger a removal.
				permissionNames: [...ROLE_PERMISSION_GRANTS.admin, "extra:grant"],
			},
		];
		const ops = planRoleSync(existing, {
			admin: ROLE_PERMISSION_GRANTS.admin,
		});
		expect(ops).toEqual([]);
	});

	it("does not delete roles Descope has that the model omits", () => {
		const existing = [
			{ name: "legacy-role", description: "", permissionNames: ["apps:read"] },
		];
		const ops = planRoleSync(existing, {});
		expect(ops).toHaveLength(0);
	});
});

describe("buildDescopeRbacPlan", () => {
	it("is a no-op fixpoint against an already-synced snapshot", () => {
		const plan = buildDescopeRbacPlan(inSyncSnapshot());
		expect(planIsEmpty(plan)).toBe(true);
		expect(formatDescopeRbacPlan(plan)).toContain("in sync");
	});

	it("provisions the whole model against an empty project", () => {
		const plan = buildDescopeRbacPlan({ permissions: [], roles: [] });
		expect(plan.permissions).toHaveLength(ALL_PERMISSIONS.length);
		expect(plan.roles).toHaveLength(Object.keys(ROLE_PERMISSION_GRANTS).length);
		expect(planIsEmpty(plan)).toBe(false);
	});

	it("is idempotent: applying then re-planning yields an empty plan", async () => {
		// Simulate a Descope project by mutating an in-memory snapshot as ops apply.
		const state: DescopeRbacSnapshot = { permissions: [], roles: [] };
		const ok: DescopeSdkResult = { ok: true };
		const client: DescopeRbacManagementClient = {
			management: {
				permission: {
					create: async (name, description) => {
						state.permissions.push({ name, description });
						return ok;
					},
					update: async (name, _newName, description) => {
						const p = state.permissions.find((x) => x.name === name);
						if (p) p.description = description;
						return ok;
					},
				},
				role: {
					create: async (name, description, permissionNames) => {
						state.roles.push({
							name,
							description,
							permissionNames: permissionNames ?? [],
						});
						return ok;
					},
					update: async (name, _newName, description, permissionNames) => {
						const r = state.roles.find((x) => x.name === name);
						if (r) {
							r.description = description;
							r.permissionNames = permissionNames ?? [];
						}
						return ok;
					},
				},
			},
		};

		const firstPlan = buildDescopeRbacPlan(state);
		const applied = await applyDescopeRbacPlan(client, firstPlan);
		expect(applied.appliedPermissionOps).toBe(ALL_PERMISSIONS.length);
		expect(applied.appliedRoleOps).toBe(
			Object.keys(ROLE_PERMISSION_GRANTS).length,
		);

		const secondPlan = buildDescopeRbacPlan(state);
		expect(planIsEmpty(secondPlan)).toBe(true);
	});
});

describe("applyDescopeRbacPlan", () => {
	it("throws (and stops) when Descope returns a failure", async () => {
		const client: DescopeRbacManagementClient = {
			management: {
				permission: {
					create: async () => ({
						ok: false,
						code: 400,
						error: { errorMessage: "bad request" },
					}),
					update: async () => ({ ok: true }),
				},
				role: {
					create: async () => ({ ok: true }),
					update: async () => ({ ok: true }),
				},
			},
		};
		const plan = buildDescopeRbacPlan({ permissions: [], roles: [] });
		await expect(applyDescopeRbacPlan(client, plan)).rejects.toThrow(
			/permission.create/,
		);
	});
});

/**
 * The alias that could have made "superset-safe" a lie.
 *
 * `planRoleSync` never removes a permission because it emits the UNION of what
 * Descope already grants and what the model wants. That holds only if the
 * snapshot is accurate. `management.role.update` REPLACES a role's permission
 * set, so a role whose permissions arrived under Descope's `permissionsNames`
 * alias would snapshot as EMPTY, make the union equal the desired set alone,
 * and silently drop every Console-added permission — precisely the thing the
 * module's contract promises survives untouched.
 */
describe("readDescopeRolePermissionNames", () => {
	it("reads the documented spelling", () => {
		expect(
			readDescopeRolePermissionNames({ permissionNames: ["apps:read"] }),
		).toEqual(["apps:read"]);
	});

	it("reads the permissionsNames alias Descope also returns", () => {
		expect(
			readDescopeRolePermissionNames({ permissionsNames: ["apps:read"] }),
		).toEqual(["apps:read"]);
	});

	it("prefers the documented spelling when both are present", () => {
		expect(
			readDescopeRolePermissionNames({
				permissionNames: ["apps:read"],
				permissionsNames: ["billing:manage"],
			}),
		).toEqual(["apps:read"]);
	});

	it("treats an absent role permission list as empty, not undefined", () => {
		expect(readDescopeRolePermissionNames({})).toEqual([]);
		expect(readDescopeRolePermissionNames({ permissionNames: null })).toEqual(
			[],
		);
	});

	it("reads an aliased permission list before removing non-canonical grants", () => {
		// The regression itself: an aliased role carrying a permission the model
		// does not know about must still appear in the union the plan writes back.
		const ops = planRoleSync(
			[
				{
					name: "admin",
					permissionNames: readDescopeRolePermissionNames({
						permissionsNames: ["console:only", "apps:read"],
					}),
				},
			],
			{ admin: ["apps:read", "team:manage"] },
		);
		const op = ops.find((o) => o.name === "admin");
		expect(op?.kind).toBe("update-role-permissions");
		if (op?.kind !== "update-role-permissions")
			throw new Error("wrong op kind");
		expect(op.permissionNames).toContain("console:only");
		expect(op.permissionNames).toContain("team:manage");
		expect(op.addedPermissions).toEqual(["team:manage"]);
	});

	it("does not manufacture console-only grants from an incomplete snapshot", () => {
		// Same role, snapshotted the way the script used to: `permissionNames`
		// only, so the alias is invisible and the snapshot reads empty.
		const ops = planRoleSync([{ name: "admin", permissionNames: [] }], {
			admin: ["apps:read", "team:manage"],
		});
		const op = ops.find((o) => o.name === "admin");
		expect(op?.kind).toBe("update-role-permissions");
		if (op?.kind === "update-role-permissions") {
			expect(op.permissionNames).not.toContain("console:only");
		}
	});
});

/**
 * Reading the live snapshot.
 *
 * The dangerous failure here is the mirror of the FGA drift bug: if a failed
 * `loadAll` returned an EMPTY snapshot instead of throwing, the planner would
 * read it as "Descope has nothing" and emit a plan to provision every
 * permission and role. That renders as catastrophic drift when the truth is
 * that we could not look — and on `--apply` it would rewrite every role's
 * permission set from a snapshot that describes nothing.
 */
describe("readDescopeRbacSnapshot", () => {
	const client = (
		permissions: unknown,
		roles: unknown,
	): Parameters<typeof readDescopeRbacSnapshot>[0] =>
		({
			management: {
				permission: { loadAll: async () => permissions },
				role: { loadAll: async () => roles },
			},
		}) as never;

	it("throws when the permission read fails", async () => {
		await expect(
			readDescopeRbacSnapshot(
				client(
					{ ok: false, error: { errorMessage: "unauthorized" } },
					{ ok: true, data: [] },
				),
			),
		).rejects.toThrow(/permission\.loadAll failed.*unauthorized/);
	});

	it("throws when the role read fails", async () => {
		await expect(
			readDescopeRbacSnapshot(
				client({ ok: true, data: [] }, { ok: false, code: 500 }),
			),
		).rejects.toThrow(/role\.loadAll failed \[500\]/);
	});

	it("throws when a call succeeds with no data", async () => {
		await expect(
			readDescopeRbacSnapshot(client({ ok: true }, { ok: true, data: [] })),
		).rejects.toThrow(/permission\.loadAll failed/);
	});

	it("reads the permissionsNames alias through the shared reader", async () => {
		const snapshot = await readDescopeRbacSnapshot(
			client(
				{ ok: true, data: [{ name: "apps:read" }] },
				{
					ok: true,
					data: [{ name: "admin", permissionsNames: ["apps:read"] }],
				},
			),
		);
		expect(snapshot.roles[0]?.permissionNames).toEqual(["apps:read"]);
	});

	it("produces a snapshot the planner sees no ROLE drift in", async () => {
		// End to end: a live-shaped snapshot carrying exactly the canonical grants
		// must yield no role ops. Asserted on role ops rather than an empty plan
		// because the planner also FILLS IN missing descriptions, and this
		// synthetic snapshot omits permission descriptions that real Descope has —
		// so an empty plan would be asserting something this fixture never claims.
		const snapshot = await readDescopeRbacSnapshot(
			client(
				{ ok: true, data: ALL_PERMISSIONS.map((name) => ({ name })) },
				{
					ok: true,
					data: Object.entries(ROLE_PERMISSION_GRANTS).map(
						([name, permissionNames]) => ({
							name,
							description: "seeded",
							permissionNames: [
								...permissionNames,
								...(["owner", "admin"].includes(name)
									? ["User Admin", "SSO Admin"]
									: []),
							],
						}),
					),
				},
			),
		);
		expect(buildDescopeRbacPlan(snapshot).roles).toEqual([]);
	});
});

/**
 * Turning a provisioning plan into a drift report.
 *
 * The distinction that matters: the plan answers "what would I write?", drift
 * answers "what is wrong?". Description backfill is a write the sync would make
 * and is NOT wrong — counting it would leave an aligned project permanently red
 * and train everyone to ignore the signal.
 */
describe("summarizeDescopeRbacDrift", () => {
	it("reports nothing wrong for an empty plan", () => {
		const drift = summarizeDescopeRbacDrift({ permissions: [], roles: [] });
		expect(drift.inSync).toBe(true);
		expect(drift.missingPermissions).toEqual([]);
		expect(drift.rolesMissingPermissions).toEqual([]);
	});

	it("does not count description backfill as drift", () => {
		const drift = summarizeDescopeRbacDrift({
			permissions: [
				{ kind: "describe-permission", name: "apps:read", description: "x" },
			],
			roles: [],
		});
		expect(drift.inSync).toBe(true);
		expect(drift.undescribedPermissions).toEqual(["apps:read"]);
		expect(drift.missingPermissions).toEqual([]);
	});

	it("reports a missing permission as real drift", () => {
		const drift = summarizeDescopeRbacDrift({
			permissions: [
				{ kind: "create-permission", name: "os:approve", description: "x" },
			],
			roles: [],
		});
		expect(drift.inSync).toBe(false);
		expect(drift.missingPermissions).toEqual(["os:approve"]);
	});

	it("reports a missing role and a role missing grants", () => {
		const drift = summarizeDescopeRbacDrift({
			permissions: [],
			roles: [
				{
					kind: "create-role",
					name: "viewer",
					description: "x",
					permissionNames: ["apps:read"],
				},
				{
					kind: "update-role-permissions",
					name: "admin",
					description: "x",
					permissionNames: ["apps:read", "team:manage"],
					addedPermissions: ["team:manage"],
				},
			],
		});
		expect(drift.inSync).toBe(false);
		expect(drift.missingRoles).toEqual(["viewer"]);
		expect(drift.rolesMissingPermissions).toEqual([
			{ role: "admin", missingPermissions: ["team:manage"] },
		]);
	});

	it("preserves console-only grants without reporting drift", () => {
		const plan = buildDescopeRbacPlan({
			permissions: ALL_PERMISSIONS.map((name) => ({
				name,
				description: "seeded",
			})),
			roles: Object.entries(ROLE_PERMISSION_GRANTS).map(
				([name, permissionNames]) => ({
					name,
					description: "seeded",
					permissionNames: [
						...permissionNames,
						...(["owner", "admin"].includes(name)
							? ["User Admin", "SSO Admin"]
							: []),
						"console:only",
					],
				}),
			),
		});
		const drift = summarizeDescopeRbacDrift(plan);
		expect(drift.inSync).toBe(true);
		expect(drift.rolesWithExcessPermissions).toEqual([]);
	});

	it("sorts everything so two clean runs compare equal", () => {
		const drift = summarizeDescopeRbacDrift({
			permissions: [
				{ kind: "create-permission", name: "b:x", description: "" },
				{ kind: "create-permission", name: "a:x", description: "" },
			],
			roles: [
				{
					kind: "update-role-permissions",
					name: "zed",
					description: "",
					permissionNames: [],
					addedPermissions: ["z:x", "a:x"],
				},
				{
					kind: "update-role-permissions",
					name: "abe",
					description: "",
					permissionNames: [],
					addedPermissions: ["m:x"],
				},
			],
		});
		expect(drift.missingPermissions).toEqual(["a:x", "b:x"]);
		expect(drift.rolesMissingPermissions.map((r) => r.role)).toEqual([
			"abe",
			"zed",
		]);
		expect(drift.rolesMissingPermissions[0]?.missingPermissions).toEqual([
			"m:x",
		]);
		expect(drift.rolesMissingPermissions[1]?.missingPermissions).toEqual([
			"a:x",
			"z:x",
		]);
	});
});

/**
 * Permissions Descope holds that nothing can evaluate.
 *
 * Provisioning adds missing permissions; this report also detects grants
 * unsupported by the authorization model.
 */
describe("findUnusableDescopePermissions", () => {
	it("finds a permission no guard can ever evaluate", () => {
		expect(
			findUnusableDescopePermissions(["apps:read", "content:manage"]),
		).toEqual(["content:manage"]);
	});

	it("does not flag Descope's own built-ins", () => {
		// `User Admin` is load-bearing: Descope requires it for the embedded Role
		// Management widget, so calling it unusable would be actively wrong.
		expect(
			findUnusableDescopePermissions([...DESCOPE_BUILT_IN_PERMISSIONS]),
		).toEqual([]);
	});

	it("does not flag anything the model defines", () => {
		expect(findUnusableDescopePermissions([...ALL_PERMISSIONS])).toEqual([]);
	});

	it("reports unsupported grants alongside valid permissions", () => {
		const live = [
			...ALL_PERMISSIONS,
			...DESCOPE_BUILT_IN_PERMISSIONS,
			"content:manage",
			"storage:read",
			"storage:write",
			"tools:invoke",
		];
		expect(findUnusableDescopePermissions(live)).toEqual([
			"content:manage",
			"storage:read",
			"storage:write",
			"tools:invoke",
		]);
	});

	it("is deduplicated and sorted", () => {
		expect(findUnusableDescopePermissions(["z:x", "a:x", "z:x"])).toEqual([
			"a:x",
			"z:x",
		]);
	});

	it("never affects inSync, because no sync can resolve it", () => {
		const drift = summarizeDescopeRbacDrift(
			{ permissions: [], roles: [] },
			{
				permissions: [{ name: "content:manage" }],
				roles: [],
			},
		);
		expect(drift.unusablePermissions).toEqual(["content:manage"]);
		expect(drift.inSync).toBe(true);
	});

	it("reports nothing when the caller passes no snapshot", () => {
		expect(
			summarizeDescopeRbacDrift({ permissions: [], roles: [] })
				.unusablePermissions,
		).toEqual([]);
	});
});
