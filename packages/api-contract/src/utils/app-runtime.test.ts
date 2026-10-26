import { describe, expect, it } from "vite-plus/test";
import {
	APP_RUNTIME_ENTRY,
	APP_RUNTIME_OPERATIONS,
	AppRuntimeFilesSchema,
	AppRuntimeRoleSchema,
} from "../schemas/os-app-runtime";
import { OsGadgetManifestWriteSchema } from "../schemas/os-workspaces";
import {
	appRuntimeCodeId,
	appRuntimeLoaderManifest,
	appRuntimePermission,
	isAppRuntimeManifest,
	loadAppRuntimeWorker,
} from "./app-runtime";

const files = {
	"server.js": "export class App {}",
	"client.js": "document.body.textContent = 'hi'",
};

describe("app runtime files", () => {
	it("requires server.js and client.js with safe names", () => {
		expect(AppRuntimeFilesSchema.safeParse(files).success).toBe(true);
		expect(AppRuntimeFilesSchema.safeParse({ "server.js": "" }).success).toBe(
			false,
		);
		expect(
			AppRuntimeFilesSchema.safeParse({ ...files, "../x.js": "" }).success,
		).toBe(false);
		expect(
			AppRuntimeFilesSchema.safeParse({ ...files, "Styles.CSS": "" }).success,
		).toBe(false);
	});

	it("carries an authored README without loading it as executable code", () => {
		const authored = { ...files, "README.md": "# Review app" };
		expect(AppRuntimeFilesSchema.parse(authored)).toEqual(authored);
		expect(appRuntimeLoaderManifest(authored).modules).toEqual(files);
		expect(
			AppRuntimeFilesSchema.safeParse({ ...files, "other.md": "" }).success,
		).toBe(false);
	});

	it("caps the total code length", () => {
		const big = "x".repeat(300_000);
		expect(
			AppRuntimeFilesSchema.safeParse({
				"server.js": big,
				"client.js": big,
			}).success,
		).toBe(false);
	});

	it("validates the runtime config on a manifest write", () => {
		const good = OsGadgetManifestWriteSchema.safeParse({
			entry: APP_RUNTIME_ENTRY,
			capabilities: [],
			config: { version: 1, settings: { sheetTitle: "Opportunities" } },
		});
		expect(good.success).toBe(true);
		const bad = OsGadgetManifestWriteSchema.safeParse({
			entry: APP_RUNTIME_ENTRY,
			capabilities: [],
			config: { version: 2 },
		});
		expect(bad.success).toBe(false);
		expect(isAppRuntimeManifest({ entry: ` ${APP_RUNTIME_ENTRY} ` })).toBe(
			true,
		);
		expect(isAppRuntimeManifest({ entry: "tedix:app/card-review" })).toBe(
			false,
		);
	});
});

describe("loader manifest", () => {
	it("loads the shared invocation manifest without caller-side customization", async () => {
		const options = {
			invocation: {
				config: { sheet: "fictional-sheet" },
				tails: [{ name: "ledger" }],
			},
		};
		const expected = appRuntimeLoaderManifest(files, options);
		let loaded: Promise<typeof expected> | undefined;
		const stub = { id: "loaded-worker" };
		const worker = loadAppRuntimeWorker(
			{
				get(id: string, code: () => Promise<typeof expected>) {
					expect(id).toBe("fictional-code-id");
					loaded = code();
					return stub;
				},
			},
			"fictional-code-id",
			files,
			options,
		);
		expect(worker).toBe(stub);
		expect(await loaded).toEqual(expected);
		expect(expected.mainModule).toBe("__tedix_invocation.js");
		expect(expected.modules[expected.mainModule]).toContain(
			"{ CONFIG: this.env.CONFIG, TEDIX: capability }",
		);
		expect(expected.env).toEqual({ CONFIG: options.invocation.config });
		expect(expected.tails).toEqual(options.invocation.tails);
		expect(expected.globalOutbound).toBeNull();
		expect(expected.compatibilityFlags).toContain("disallow_importable_env");
		expect(expected.compatibilityFlags).toContain("nodejs_als");
	});
	it("never inherits network access and changes id with the code", () => {
		const manifest = appRuntimeLoaderManifest(files);
		expect(manifest.globalOutbound).toBeNull();
		expect(manifest.mainModule).toBe("server.js");
		expect(Object.keys(manifest.modules)).toEqual(["server.js", "client.js"]);
		const parts = {
			organizationId: "org_blueharbor",
			workspaceId: "11111111-1111-4111-8111-111111111111",
			gadgetId: "22222222-2222-4222-8222-222222222222",
			revision: 3,
		};
		expect(appRuntimeCodeId(parts)).not.toBe(
			appRuntimeCodeId({ ...parts, revision: 4 }),
		);
		expect(appRuntimeCodeId({ ...parts, draftId: "d1" })).toContain(
			":draft:d1",
		);
	});
});

describe("permission matrix", () => {
	const grants = [{ slot: "opportunities", operations: ["outputs.read"] }];

	it("lets use read a granted sheet and refuses writes", () => {
		expect(
			appRuntimePermission({
				role: "use",
				operation: "outputs.read",
				grants,
				slot: "opportunities",
			}),
		).toEqual({ allowed: true });
		expect(
			appRuntimePermission({
				role: "use",
				operation: "outputs.write",
				grants,
				slot: "opportunities",
			}),
		).toEqual({ allowed: false, reason: "role" });
	});

	it("needs a grant even for build, and the grant must name the operation", () => {
		expect(
			appRuntimePermission({
				role: "build",
				operation: "outputs.write",
				grants,
				slot: "opportunities",
			}),
		).toEqual({ allowed: false, reason: "grant_operation" });
		expect(
			appRuntimePermission({
				role: "build",
				operation: "outputs.read",
				grants,
				slot: "other",
			}),
		).toEqual({ allowed: false, reason: "no_grant" });
		expect(
			appRuntimePermission({
				role: "owner",
				operation: "outputs.read",
				grants,
			}),
		).toEqual({ allowed: false, reason: "slot_required" });
	});

	it("gives viewer nothing and app.call to everyone else without a grant", () => {
		for (const operation of APP_RUNTIME_OPERATIONS)
			expect(
				appRuntimePermission({ role: "viewer", operation, grants }).allowed,
			).toBe(false);
		for (const role of AppRuntimeRoleSchema.options.filter(
			(r) => r !== "viewer",
		))
			expect(
				appRuntimePermission({ role, operation: "app.call", grants }),
			).toEqual({ allowed: true });
	});
});
