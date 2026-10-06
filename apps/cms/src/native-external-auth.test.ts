import { DatabaseSync } from "node:sqlite";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const provider = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/auth", () => ({ authenticate: provider.authenticate }));

/** Real SQLite uniqueness, driven through the installed native middleware and its SQL builder calls. */
function fixture(concurrentFirstReads = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, role INTEGER, email_verified INTEGER, created_at TEXT, updated_at TEXT, disabled INTEGER DEFAULT 0)",
	);
	let reads = 0;
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const db = {
		readUser: async (email: string) => {
			const row = sqlite
				.prepare("SELECT * FROM users WHERE email = ?")
				.get(email);
			if (concurrentFirstReads && reads++ < 2) {
				if (reads === 2) release();
				await barrier;
			}
			return row ?? null;
		},
		selectFrom: (_table: string) => ({
			selectAll: () => ({
				where: (_column: string, _operator: string, email: string) => ({
					executeTakeFirst: () => db.readUser(email),
				}),
			}),
		}),
		insertInto: (_table: string) => ({
			values: (row: Record<string, unknown>) => {
				let conflict = "";
				const builder = {
					onConflict: (
						callback: (clause: {
							column: (name: string) => { doNothing: () => void };
						}) => unknown,
					) => {
						callback({
							column: (name) => ({
								doNothing: () => {
									expect(name).toBe("email");
									conflict = " ON CONFLICT(email) DO NOTHING";
								},
							}),
						});
						return builder;
					},
					execute: async () => {
						const keys = Object.keys(row);
						sqlite
							.prepare(
								`INSERT INTO users (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})${conflict}`,
							)
							.run(...(Object.values(row) as (string | number)[]));
					},
				};
				return builder;
			},
		}),
		updateTable: (_table: string) => ({
			set: (row: Record<string, unknown>) => ({
				where: (_column: string, _operator: string, id: string) => ({
					execute: async () => {
						sqlite
							.prepare(
								`UPDATE users SET ${Object.keys(row)
									.map((key) => `${key} = ?`)
									.join(",")} WHERE id = ?`,
							)
							.run(...(Object.values(row) as (string | number)[]), id);
					},
				}),
			}),
		}),
	};
	return { sqlite, db };
}

const authResult = {
	email: "editor@example.invalid",
	name: "Editor",
	role: 40,
};
beforeEach(() => {
	vi.stubEnv("DEV", false);
	provider.authenticate.mockReset().mockResolvedValue(authResult);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

const modules = [
	[
		"Tedix",
		"../templates/tedix/node_modules/emdash/dist/astro/middleware/auth.mjs",
	],
	[
		"Marketing",
		"../templates/marketing/node_modules/emdash/dist/astro/middleware/auth.mjs",
	],
] as const;

describe.each(modules)(
	"%s installed native external authentication",
	(_name, module) => {
		async function run(db: ReturnType<typeof fixture>["db"]) {
			const { onRequest } = await import(new URL(module, import.meta.url).href);
			const request = new Request(
				"https://example.invalid/_emdash/api/settings",
				{ headers: { "X-EmDash-Request": "1" } },
			);
			const locals: { emdash: unknown; user?: Record<string, unknown> } = {
				emdash: {
					db,
					config: {
						auth: {
							entrypoint: "fixture",
							config: { autoProvision: true, syncRoles: true },
						},
					},
				},
			};
			let downstream = 0;
			const response: Response = await onRequest(
				{ request, url: new URL(request.url), locals },
				async () => {
					downstream++;
					return new Response("ok");
				},
			);
			return { response, locals, downstream };
		}
		it("two concurrent first requests authenticate with one native user and no provider retries", async () => {
			const { sqlite, db } = fixture(true);
			try {
				const results = await Promise.all([run(db), run(db)]);
				expect(results.map((result) => result.response.status)).toEqual([
					200, 200,
				]);
				expect(results[0]!.locals.user?.id).toBe(results[1]!.locals.user?.id);
				expect(results.map((result) => result.locals.user?.role)).toEqual([
					40, 40,
				]);
				expect(
					sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
				).toBe(1);
				expect(provider.authenticate).toHaveBeenCalledTimes(2);
			} finally {
				sqlite.close();
			}
		});
		it("syncs provider attributes when another first request wins the email insert", async () => {
			const { sqlite, db } = fixture(true);
			provider.authenticate
				.mockResolvedValueOnce(authResult)
				.mockResolvedValueOnce({
					...authResult,
					name: "Second editor",
					role: 30,
				});
			try {
				const results = await Promise.all([run(db), run(db)]);
				expect(results.map(({ response }) => response.status)).toEqual([
					200, 200,
				]);
				expect(results.map(({ locals }) => locals.user?.role)).toEqual([
					40, 30,
				]);
				expect(results[1]!.locals.user?.name).toBe("Second editor");
				expect(
					sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()?.count,
				).toBe(1);
				expect(provider.authenticate).toHaveBeenCalledTimes(2);
			} finally {
				sqlite.close();
			}
		});

		it("uses authoritative provider role and name for existing accounts", async () => {
			const { sqlite, db } = fixture();
			try {
				sqlite
					.prepare("INSERT INTO users (id,email,name,role) VALUES (?,?,?,?)")
					.run("existing", authResult.email, "Previous", 50);
				const { response, locals } = await run(db);
				expect(response.status).toBe(200);
				expect(locals.user).toMatchObject({
					id: "existing",
					role: 40,
					name: "Editor",
				});
				expect(
					sqlite
						.prepare("SELECT role,name FROM users WHERE id = 'existing'")
						.get(),
				).toMatchObject({ role: 40, name: "Editor" });
			} finally {
				sqlite.close();
			}
		});
		it("preserves disabled-account refusal without running the downstream route", async () => {
			const { sqlite, db } = fixture();
			try {
				sqlite
					.prepare(
						"INSERT INTO users (id,email,name,role,disabled) VALUES (?,?,?,?,?)",
					)
					.run("disabled", authResult.email, "Editor", 40, 1);
				const { response, downstream } = await run(db);
				expect(response.status).toBe(403);
				expect(await response.text()).toBe("Account disabled");
				expect(downstream).toBe(0);
				expect(provider.authenticate).toHaveBeenCalledTimes(1);
			} finally {
				sqlite.close();
			}
		});
	},
);
