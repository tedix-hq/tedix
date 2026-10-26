import { describe, expect, it } from "vite-plus/test";
import {
	APP_RUNTIME_OPERATIONS,
	AppRuntimeFilesSchema,
	AppRuntimeMethodSchema,
	type AppRuntimeOperation,
	type AppRuntimeRole,
	AppRuntimeRoleSchema,
} from "../schemas/os-app-runtime";
import {
	appRuntimeCodeDigest,
	appRuntimeCodeId,
	appRuntimeLoaderManifest,
	appRuntimeOperationsForRole,
	appRuntimePermission,
	loadAppRuntimeWorker,
} from "./app-runtime";

/**
 * Property tests for the app runtime's authority boundary. The role x
 * operation x grant space is small enough to enumerate exhaustively, so every
 * combination is checked rather than sampled.
 */

const ROLES = AppRuntimeRoleSchema.options;
const OPERATIONS = APP_RUNTIME_OPERATIONS;
const GRANT_GATED = new Set<AppRuntimeOperation>([
	"outputs.read",
	"outputs.patch",
	"outputs.write",
	"connections.call",
	"skills.run",
]);
const RANK: Record<AppRuntimeRole, number> = {
	viewer: 0,
	use: 1,
	build: 2,
	owner: 3,
};
/** Names that resolve to something on Object.prototype when used as keys. */
const HOSTILE_NAMES = [
	"__proto__",
	"constructor",
	"prototype",
	"toString",
	"hasOwnProperty",
	"valueOf",
	"admin",
	"",
	"OWNER",
	"build ",
];

function subsets<T>(items: readonly T[]): T[][] {
	return items.reduce<T[][]>(
		(all, item) => all.concat(all.map((set) => [...set, item])),
		[[]],
	);
}

const GRANT_OPERATION_SETS = subsets(OPERATIONS);
const SLOTS = [undefined, "", "sheet", "other", "__proto__"];

function* everyCase() {
	for (const role of ROLES)
		for (const operation of OPERATIONS)
			for (const operations of GRANT_OPERATION_SETS)
				for (const slot of SLOTS)
					yield {
						role,
						operation,
						slot,
						grants: [{ slot: "sheet", operations }],
					};
}

describe("app runtime permission matrix, exhaustively", () => {
	it("covers every role, operation, grant set and slot", () => {
		expect([...everyCase()].length).toBe(
			ROLES.length * OPERATIONS.length * 2 ** OPERATIONS.length * SLOTS.length,
		);
	});

	it("allows only what both the role and the manifest grant name", () => {
		for (const input of everyCase()) {
			const decision = appRuntimePermission(input);
			const roleAllows =
				input.role === "owner" ||
				input.role === "build" ||
				(input.role === "use" &&
					(input.operation === "app.call" ||
						input.operation === "outputs.read"));
			const granted =
				input.slot === "sheet" &&
				input.grants[0]!.operations.includes(input.operation);
			const expected =
				roleAllows && (!GRANT_GATED.has(input.operation) || granted);
			expect(decision.allowed, JSON.stringify(input)).toBe(expected);
		}
	});

	it("keeps use to app.call and outputs.read, and viewer to nothing", () => {
		expect([...appRuntimeOperationsForRole("use")].sort()).toEqual([
			"app.call",
			"outputs.read",
		]);
		expect(appRuntimeOperationsForRole("viewer")).toEqual([]);
		for (const input of everyCase()) {
			if (input.role === "viewer")
				expect(appRuntimePermission(input)).toEqual({
					allowed: false,
					reason: "role",
				});
			if (
				input.role === "use" &&
				input.operation !== "app.call" &&
				input.operation !== "outputs.read"
			)
				expect(appRuntimePermission(input).allowed).toBe(false);
		}
	});

	it("never lets a lower role do what a higher role cannot (monotone in role)", () => {
		for (const input of everyCase())
			for (const higher of ROLES) {
				if (RANK[higher] < RANK[input.role]) continue;
				if (appRuntimePermission(input).allowed)
					expect(
						appRuntimePermission({ ...input, role: higher }).allowed,
						`${input.role} -> ${higher} ${input.operation}`,
					).toBe(true);
			}
	});

	it("never widens a decision when grants are added for other slots or operations", () => {
		for (const input of everyCase()) {
			const before = appRuntimePermission(input).allowed;
			const unrelated = appRuntimePermission({
				...input,
				grants: [
					...input.grants,
					{ slot: "unrelated", operations: [...OPERATIONS] },
				],
			}).allowed;
			expect(unrelated).toBe(before);
		}
	});

	it("needs a grant for every resource operation, whatever the role", () => {
		for (const role of ROLES)
			for (const operation of GRANT_GATED) {
				expect(
					appRuntimePermission({ role, operation, grants: [], slot: "sheet" })
						.allowed,
				).toBe(false);
				expect(
					appRuntimePermission({
						role,
						operation,
						grants: [{ slot: "sheet", operations: [...OPERATIONS] }],
					}).allowed,
				).toBe(false);
			}
	});

	it("denies roles and operations that are not in the matrix instead of throwing", () => {
		for (const name of HOSTILE_NAMES) {
			expect(
				appRuntimePermission({
					role: name as AppRuntimeRole,
					operation: "app.call",
					grants: [],
				}),
				`role ${JSON.stringify(name)}`,
			).toEqual({ allowed: false, reason: "role" });
			expect(appRuntimeOperationsForRole(name as AppRuntimeRole)).toEqual([]);
			for (const role of ROLES)
				expect(
					appRuntimePermission({
						role,
						operation: name as AppRuntimeOperation,
						grants: [{ slot: "sheet", operations: [name] }],
						slot: "sheet",
					}).allowed,
					`operation ${JSON.stringify(name)} as ${role}`,
				).toBe(false);
		}
	});

	it("does not resolve a grant through the prototype chain", () => {
		for (const role of ROLES)
			expect(
				appRuntimePermission({
					role,
					operation: "outputs.read",
					grants: [],
					slot: "__proto__",
				}).allowed,
			).toBe(false);
	});
});

describe("app method names", () => {
	it("refuses lifecycle and prototype names a caller could dispatch to", () => {
		for (const name of [
			"constructor",
			"__proto__",
			"__defineGetter__",
			"alarm",
			"webSocketMessage",
			"webSocketClose",
			"webSocketError",
			"",
			"a.b",
			"a b",
			"x".repeat(81),
			"1count",
		])
			expect(
				AppRuntimeMethodSchema.safeParse(name).success,
				JSON.stringify(name),
			).toBe(false);
		expect(AppRuntimeMethodSchema.safeParse("count").success).toBe(true);
	});
});

/** Deterministic PRNG so failures reproduce. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomFiles(next: () => number): Record<string, string> {
	const files: Record<string, string> = {
		"server.js": `export class App { n() { return ${Math.floor(next() * 1e6)}; } }`,
		"client.js": `/* ${next()} */`,
	};
	const extra = Math.floor(next() * 4);
	for (let i = 0; i < extra; i += 1)
		files[`part-${i}.${["js", "json", "txt"][i % 3]}`] = String(next());
	return files;
}

describe("loader manifest invariants", () => {
	it("never grants network, ambient env or caller-chosen flags, for any files or options", async () => {
		const next = random(20261025);
		for (let i = 0; i < 200; i += 1) {
			const files = randomFiles(next);
			const hostile = {
				validation: next() > 0.5,
				compatibilityDate: next() > 0.5 ? "2026-10-01" : undefined,
				invocation:
					next() > 0.3
						? {
								config: {
									globalOutbound: "https://example.test",
									compatibilityFlags: ["nodejs_compat"],
									LOADER: true,
								},
								tails: [],
							}
						: undefined,
				// Not part of the options type; a caller must not be able to smuggle them.
				globalOutbound: { fetch: () => undefined },
				compatibilityFlags: ["nodejs_compat"],
				env: { SECRETS_MASTER_KEY: "leak" },
			};
			for (const manifest of [
				appRuntimeLoaderManifest(files, hostile),
				await new Promise<ReturnType<typeof appRuntimeLoaderManifest>>(
					(resolve) => {
						loadAppRuntimeWorker(
							{
								get: (_id, code) => {
									void code().then(resolve);
									return null;
								},
							},
							"fictional-code-id",
							files,
							hostile,
						);
					},
				),
			]) {
				expect(manifest.globalOutbound).toBeNull();
				expect(manifest.compatibilityFlags).toEqual([
					"disallow_importable_env",
					"nodejs_als",
				]);
				expect(Object.keys(manifest.env)).toEqual(["CONFIG"]);
				expect(manifest.env.CONFIG).toEqual(hostile.invocation?.config ?? {});
				expect(Object.keys(manifest).sort()).toEqual([
					"compatibilityDate",
					"compatibilityFlags",
					"env",
					"globalOutbound",
					"mainModule",
					"modules",
					"tails",
				]);
				expect(manifest.modules[manifest.mainModule]).toBeTypeOf("string");
				if (hostile.validation)
					expect(manifest.mainModule).toBe("__tedix_validate.js");
				else if (hostile.invocation)
					expect(manifest.mainModule).toBe("__tedix_invocation.js");
				else expect(manifest.mainModule).toBe("server.js");
			}
		}
	});

	it("keeps the host invocation module even if a file claims its name", () => {
		const manifest = appRuntimeLoaderManifest(
			{
				"server.js": "export class App {}",
				"client.js": "",
				"__tedix_invocation.js": "export class AppInvocation { invoke() {} }",
			},
			{ invocation: { config: {}, tails: [] } },
		);
		expect(manifest.modules["__tedix_invocation.js"]).toContain(
			"getOwnPropertyDescriptor(App.prototype, method)",
		);
		expect(
			AppRuntimeFilesSchema.safeParse({
				"server.js": "",
				"client.js": "",
				"__tedix_invocation.js": "",
			}).success,
		).toBe(false);
	});

	it("rejects module paths that could escape one flat directory", () => {
		for (const name of [
			"../server.js",
			"a/b.js",
			"/abs.js",
			"Server.js",
			".hidden.js",
			"x.mjs",
			"x.wasm",
			"x.js\u0000",
			"cloudflare:workers.js",
			"node:fs.js",
		])
			expect(
				AppRuntimeFilesSchema.safeParse({
					"server.js": "",
					"client.js": "",
					[name]: "",
				}).success,
				JSON.stringify(name),
			).toBe(false);
	});

	it("gives every distinct file set its own digest and loader identity", async () => {
		const next = random(7);
		const parts = {
			organizationId: "org_blueharbor",
			workspaceId: "11111111-1111-4111-8111-111111111111",
			gadgetId: "22222222-2222-4222-8222-222222222222",
			revision: 1,
		};
		const digests = new Set<string>();
		const ids = new Set<string>();
		for (let i = 0; i < 100; i += 1) {
			const files = randomFiles(next);
			const codeDigest = await appRuntimeCodeDigest(files);
			digests.add(codeDigest);
			ids.add(appRuntimeCodeId({ ...parts, codeDigest }));
		}
		expect(digests.size).toBe(100);
		expect(ids.size).toBe(100);
	});

	it("changes the digest when one byte of any file changes, and ignores key order", async () => {
		const files = {
			"server.js": "export class App {}",
			"client.js": "x",
			"data.json": "{}",
		};
		const digest = await appRuntimeCodeDigest(files);
		expect(
			await appRuntimeCodeDigest({
				"data.json": "{}",
				"client.js": "x",
				"server.js": "export class App {}",
			}),
		).toBe(digest);
		for (const key of Object.keys(files) as (keyof typeof files)[])
			expect(
				await appRuntimeCodeDigest({ ...files, [key]: `${files[key]} ` }),
			).not.toBe(digest);
		// Moving content between files is a different program.
		expect(
			await appRuntimeCodeDigest({
				"server.js": "export class App {}x",
				"client.js": "",
				"data.json": "{}",
			}),
		).not.toBe(digest);
	});

	it("separates tenants, workspaces, apps, revisions and drafts in the loader identity", () => {
		const base = {
			organizationId: "org_blueharbor",
			workspaceId: "11111111-1111-4111-8111-111111111111",
			gadgetId: "22222222-2222-4222-8222-222222222222",
			revision: 1,
		};
		const variants = [
			base,
			{ ...base, organizationId: "org_northwind" },
			{ ...base, workspaceId: "33333333-3333-4333-8333-333333333333" },
			{ ...base, gadgetId: "44444444-4444-4444-8444-444444444444" },
			{ ...base, revision: 2 },
			{ ...base, draftId: "55555555-5555-4555-8555-555555555555" },
			{ ...base, codeDigest: "a".repeat(64) },
			{ ...base, codeDigest: "b".repeat(64) },
		];
		expect(new Set(variants.map(appRuntimeCodeId)).size).toBe(variants.length);
	});
});
