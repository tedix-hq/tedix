import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearAllCredentials,
	getCurrentWorkspace,
	listWorkspaces,
	readWorkspaceCredentials,
	removeWorkspace,
	setCurrentWorkspace,
	type WorkspaceCredential,
	writeWorkspaceCredentials,
} from "./credential-store";

const credential = (loginId: string): WorkspaceCredential => ({
	loginId,

	oauthTokens: {
		token_type: "Bearer",
		access_token: "session",
		refresh_token: "refresh",
	},
	accessTokenExpiresAtSeconds: 1,
	mcpUrl: `https://${loginId}-unified.mcp.tedix.dev/mcp`,
});

function configDir(): string {
	return mkdtempSync(join(tmpdir(), "tedix-credentials-"));
}

describe("credential store", () => {
	test("round-trips independent workspace credentials with hardened permissions", () => {
		const dir = configDir();
		writeWorkspaceCredentials("a", credential("a"), { configDir: dir });
		writeWorkspaceCredentials("b", credential("b"), { configDir: dir });
		expect(readWorkspaceCredentials("a", { configDir: dir })).toEqual(
			credential("a"),
		);
		expect(readWorkspaceCredentials("b", { configDir: dir })).toEqual(
			credential("b"),
		);
		expect(statSync(join(dir, "credentials.json")).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});

	test("round-trips issuer-bound SDK OAuth state", () => {
		const dir = configDir();
		const value: WorkspaceCredential = {
			...credential("sdk"),
			oauthResourceUrl: "https://sdk-unified.mcp.tedix.dev/mcp",
			oauthTokens: {
				access_token: "access",
				token_type: "Bearer",
				refresh_token: "refresh",
				issuer: "https://auth.example.com",
			},
			oauthClientInformation: {
				client_id: "client-id",
				issuer: "https://auth.example.com",
			},
			oauthDiscoveryState: {
				authorizationServerUrl: "https://auth.example.com",
				authorizationServerMetadata: {
					issuer: "https://auth.example.com",
					authorization_endpoint: "https://auth.example.com/authorize",
					token_endpoint: "https://auth.example.com/token",
					response_types_supported: ["code"],
				},
			},
		};
		writeWorkspaceCredentials("sdk", value, { configDir: dir });
		expect(readWorkspaceCredentials("sdk", { configDir: dir })).toEqual(value);
		const disk = JSON.parse(
			readFileSync(join(dir, "credentials.json"), "utf8"),
		);
		expect(disk.version).toBe(2);
		expect(disk.workspaces.sdk).toEqual(value);
	});

	test("preserves scope profile and normalizes current v2 OAuth rows on mutation", () => {
		const dir = configDir();
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				version: 2,
				current: "tedix",
				workspaces: {
					tedix: {
						...credential("tedix"),
						oauthScopeProfile: "member",
						oauthTokens: {
							access_token: "canonical",
							refresh_token: "renew",
							token_type: "Bearer",
							scope: "mcp:work.read",
						},
					},
				},
			}),
		);
		setCurrentWorkspace("tedix", { configDir: dir });
		const row = readWorkspaceCredentials("tedix", { configDir: dir });
		expect(row?.oauthScopeProfile).toBe("member");
		expect(row?.oauthTokens?.access_token).toBe("canonical");
		expect(row?.oauthTokens?.scope).toBe("mcp:work.read");
		expect(
			JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).version,
		).toBe(2);
	});

	test("parallel processes retain all updates while readers see complete JSON", async () => {
		const dir = configDir();
		writeWorkspaceCredentials("selected", credential("selected"), {
			configDir: dir,
		});
		setCurrentWorkspace("selected", { configDir: dir });
		const modulePath = new URL("./credential-store.ts", import.meta.url)
			.pathname;
		const children = Array.from({ length: 4 }, (_, processIndex) =>
			Bun.spawn(
				[
					process.execPath,
					"-e",
					`import { writeWorkspaceCredentials, removeWorkspace } from ${JSON.stringify(modulePath)}; const opts = { configDir: ${JSON.stringify(dir)} }; for (let i=0; i<30; i++) { writeWorkspaceCredentials("${processIndex}-"+i, ${JSON.stringify(credential("writer"))}, opts); writeWorkspaceCredentials("temporary-${processIndex}", ${JSON.stringify(credential("temporary"))}, opts); removeWorkspace("temporary-${processIndex}", opts); }`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			),
		);
		let done = false;
		const exited = Promise.all(children.map((child) => child.exited)).then(
			(result) => {
				done = true;
				return result;
			},
		);
		let reads = 0;
		while (!done) {
			expect(
				JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).version,
			).toBe(2);
			reads++;
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(await exited).toEqual([0, 0, 0, 0]);
		expect(reads).toBeGreaterThan(0);
		expect(listWorkspaces({ configDir: dir })).toHaveLength(121);
		expect(getCurrentWorkspace({ configDir: dir })).toBe("selected");
	});

	test("canonical grant wins over stale alias extras and mutations retain only canonical state", () => {
		const dir = configDir();
		const canonical = credential("oauth");
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				version: 2,
				current: "oauth",
				workspaces: {
					oauth: {
						...canonical,
						sessionJwt: "wrong-access",
						refreshJwt: "wrong-refresh",
						scopes: "platform:admin",
						clientId: "wrong-client",
						sessionExp: 9999999999,
						refreshExp: 9999999999,
						authorizeUrl: "wrong",
						tokenUrl: "wrong",
					},
				},
			}),
		);
		expect(readWorkspaceCredentials("oauth", { configDir: dir })).toEqual(
			canonical,
		);
		setCurrentWorkspace("oauth", { configDir: dir });
		expect(
			JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")).workspaces
				.oauth,
		).toEqual(canonical);
	});

	test("conditional renewal cannot resurrect logout or overwrite a newer login", () => {
		const dir = configDir();
		const opts = { configDir: dir };
		const original = credential("original");
		writeWorkspaceCredentials("tedix", original, opts);
		removeWorkspace("tedix", opts);
		expect(() =>
			writeWorkspaceCredentials(
				"tedix",
				{
					...original,
					oauthTokens: {
						...original.oauthTokens,
						token_type: "Bearer",
						access_token: "renewed",
					},
				},
				opts,
				original,
			),
		).toThrow("Credentials changed");
		expect(readWorkspaceCredentials("tedix", opts)).toBeNull();
		const newer = {
			...original,
			oauthTokens: {
				...original.oauthTokens,
				token_type: "Bearer",
				access_token: "new-login",
				refresh_token: "new-refresh",
			},
		};
		writeWorkspaceCredentials("tedix", newer, opts);
		expect(() =>
			writeWorkspaceCredentials(
				"tedix",
				{
					...original,
					oauthTokens: {
						...original.oauthTokens,
						token_type: "Bearer",
						access_token: "renewed",
					},
				},
				opts,
				original,
			),
		).toThrow("Credentials changed");
		expect(readWorkspaceCredentials("tedix", opts)).toEqual(newer);
		writeWorkspaceCredentials(
			"tedix",
			{
				...newer,
				oauthTokens: {
					...newer.oauthTokens,
					token_type: "Bearer",
					access_token: "renewed-current",
				},
			},
			opts,
			newer,
		);
		expect(
			readWorkspaceCredentials("tedix", opts)?.oauthTokens?.access_token,
		).toBe("renewed-current");
	});

	test("refuses to select an unknown workspace", () => {
		const dir = configDir();
		expect(() => setCurrentWorkspace("missing", { configDir: dir })).toThrow(
			/workspace "missing" is not present/,
		);
	});

	test("selects, lists, and removes workspaces", () => {
		const dir = configDir();
		writeWorkspaceCredentials("b", credential("b"), { configDir: dir });
		writeWorkspaceCredentials("a", credential("a"), { configDir: dir });
		setCurrentWorkspace("b", { configDir: dir });
		expect(getCurrentWorkspace({ configDir: dir })).toBe("b");
		expect(listWorkspaces({ configDir: dir }).map((row) => row.name)).toEqual([
			"a",
			"b",
		]);
		removeWorkspace("b", { configDir: dir });
		expect(getCurrentWorkspace({ configDir: dir })).toBe("a");
		clearAllCredentials({ configDir: dir });
		expect(listWorkspaces({ configDir: dir })).toEqual([]);
	});

	test("rejects unsupported flat credential files instead of migrating them", () => {
		const dir = configDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify(credential("old")),
		);
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args) => errors.push(args.join(" "));
		try {
			expect(listWorkspaces({ configDir: dir })).toEqual([]);
			expect(errors.join(" ")).toContain("unsupported format");
		} finally {
			console.error = original;
		}
	});

	test("drops malformed workspace rows without losing valid siblings", () => {
		const dir = configDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				version: 2,
				current: "good",
				workspaces: { good: credential("good"), bad: { loginId: 42 } },
			}),
		);
		const original = console.error;
		console.error = () => {};
		try {
			expect(listWorkspaces({ configDir: dir }).map((row) => row.name)).toEqual(
				["good"],
			);
		} finally {
			console.error = original;
		}
	});

	test("omits optional metadata with invalid types", () => {
		const dir = configDir();
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				version: 2,
				current: "good",
				workspaces: {
					good: { ...credential("good"), mcpUrl: 42, org: false },
				},
			}),
		);
		const row = readWorkspaceCredentials("good", { configDir: dir });
		expect(row?.mcpUrl).toBeUndefined();
		expect(row?.org).toBeUndefined();
	});

	test("corrupt JSON fails closed with a re-login diagnostic", () => {
		const dir = configDir();
		writeFileSync(join(dir, "credentials.json"), "{");
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args) => errors.push(args.join(" "));
		try {
			expect(listWorkspaces({ configDir: dir })).toEqual([]);
			expect(errors.join(" ")).toContain("corrupt or unreadable");
		} finally {
			console.error = original;
		}
	});

	test("TEDIX_CONFIG_DIR controls the default store location", () => {
		const dir = configDir();
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = dir;
		try {
			writeWorkspaceCredentials("env", credential("env"));
			expect(readWorkspaceCredentials("env")).toEqual(credential("env"));
		} finally {
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
	});

	test("homeDir resolves to <homeDir>/.tedix", () => {
		const home = configDir();
		writeWorkspaceCredentials("home", credential("home"), { homeDir: home });
		expect(readWorkspaceCredentials("home", { homeDir: home })).toEqual(
			credential("home"),
		);
		expect(statSync(join(home, ".tedix", "credentials.json")).isFile()).toBe(
			true,
		);
	});
});

test.each([
	{ oauthTokens: [] },
	{ oauthTokens: { access_token: 123, token_type: "Bearer" } },
	{ oauthTokens: { access_token: "access", token_type: 123 } },
	{
		oauthTokens: {
			access_token: "access",
			token_type: "Bearer",
			refresh_token: 123,
		},
	},
	{
		oauthTokens: { access_token: "access", token_type: "Bearer", issuer: 123 },
	},
	{ oauthClientInformation: [] },
	{ oauthClientInformation: { client_id: 123 } },
	{ oauthClientInformation: { client_id: "client", client_secret: 123 } },
])(
	"rejects malformed canonical authority while retaining valid siblings: %j",
	(malformed) => {
		const dir = configDir();
		writeFileSync(
			join(dir, "credentials.json"),
			JSON.stringify({
				version: 2,
				current: "good",
				workspaces: {
					good: credential("good"),
					bad: { ...credential("bad"), ...malformed },
				},
			}),
		);
		const original = console.error;
		const errors: string[] = [];
		console.error = (...args) => {
			errors.push(args.join(" "));
		};
		try {
			expect(readWorkspaceCredentials("bad", { configDir: dir })).toBeNull();
			expect(readWorkspaceCredentials("good", { configDir: dir })).toEqual(
				credential("good"),
			);
			expect(errors.join(" ")).toContain("bad");
		} finally {
			console.error = original;
		}
	},
);

test("malformed duration remains unknown without losing canonical tokens", () => {
	const dir = configDir();
	writeFileSync(
		join(dir, "credentials.json"),
		JSON.stringify({
			version: 2,
			current: "grant",
			workspaces: {
				grant: {
					loginId: "user",
					oauthTokens: {
						access_token: "access",
						refresh_token: "refresh",
						token_type: "Bearer",
						expires_in: "invalid",
					},
				},
			},
		}),
	);
	const row = readWorkspaceCredentials("grant", { configDir: dir });
	expect(row?.oauthTokens).toEqual({
		access_token: "access",
		refresh_token: "refresh",
		token_type: "Bearer",
	});
	expect(row?.accessTokenExpiresAtSeconds).toBeUndefined();
});
