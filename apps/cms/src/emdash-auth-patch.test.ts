import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

// Execute Emdash's installed middleware rather than a copy of the role
// expression. Astro's virtual auth/config modules prevent importing the
// complete package in a Vitest process, so isolate its actual compiled handler
// and provide only the provider and persistence dependencies it calls.
const middleware = readFileSync(
	new URL(
		"../templates/tedix/node_modules/emdash/dist/astro/middleware/auth.mjs",
		import.meta.url,
	),
	"utf8",
);
const handlerStart = middleware.indexOf("async function handleExternalAuth(");
const handlerEnd = middleware.indexOf(
	"\nasync function handleBearerAuth(",
	handlerStart,
);

if (handlerStart < 0 || handlerEnd < 0) {
	throw new Error(
		"Emdash external-auth handler not found in installed package",
	);
}

type ProvisionedUser = {
	id: string;
	email: string;
	name: string;
	role: number;
	[key: string]: unknown;
};

async function provisionFirstExternalUser(providerRole: number) {
	const users: ProvisionedUser[] = [];
	const db = {
		selectFrom: vi.fn(() => {
			throw new Error("External auth must not infer role from user count");
		}),
		insertInto: (table: string) => {
			expect(table).toBe("users");
			return {
				values: (user: ProvisionedUser) => {
					let ignoreEmailConflict = false;
					const conflict = {
						column: (column: string) => {
							expect(column).toBe("email");
							return {
								doNothing: () => {
									ignoreEmailConflict = true;
								},
							};
						},
					};
					const insert = {
						onConflict: (configure: (value: typeof conflict) => unknown) => {
							configure(conflict);
							return insert;
						},
						execute: async () => {
							if (!users.some((existing) => existing.email === user.email)) {
								users.push(user);
							} else if (!ignoreEmailConflict) {
								throw new Error("Duplicate email");
							}
						},
					};
					return insert;
				},
			};
		},
	};
	const authenticate = vi.fn(async () => ({
		email: "first@example.com",
		name: "First Editor",
		role: providerRole,
	}));
	const createKyselyAdapter = () => ({
		getUserByEmail: async (email: string) =>
			users.find((user) => user.email === email),
	});
	type Authenticate = typeof authenticate;
	type AdapterFactory = typeof createKyselyAdapter;
	const createHandler = new Function(
		"authenticate",
		"createKyselyAdapter",
		"ulid",
		"MW_CACHE_HEADERS",
		`${middleware.slice(handlerStart, handlerEnd)}\nreturn handleExternalAuth;`,
	) as (
		provider: Authenticate,
		adapterFactory: AdapterFactory,
		ulid: () => string,
		cacheHeaders: Record<string, string>,
	) => (
		context: {
			locals: { emdash: { db: typeof db }; user?: ProvisionedUser };
			request: Request;
			session: { set: (key: string, value: unknown) => void };
		},
		next: () => Promise<Response>,
		authMode: { entrypoint: string; config: { autoProvision: boolean } },
		isApiRoute: boolean,
	) => Promise<Response>;
	const handleExternalAuth = createHandler(
		authenticate,
		createKyselyAdapter,
		() => "first-user-id",
		{ "Cache-Control": "private, no-store" },
	);
	const context = {
		locals: { emdash: { db } } as {
			emdash: { db: typeof db };
			user?: ProvisionedUser;
		},
		request: new Request("https://example.com/_emdash/api/admin"),
		session: { set: vi.fn() },
	};
	const next = vi.fn(async () => new Response("ok", { status: 200 }));
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		const response = await handleExternalAuth(
			context,
			next,
			{ entrypoint: "descope", config: { autoProvision: true } },
			true,
		);
		return { response, users, context, next, db };
	} finally {
		log.mockRestore();
	}
}

describe("Emdash external-auth patch", () => {
	it.each([
		["viewer", 10],
		["editor", 40],
		["admin", 50],
	])("provisions the first %s with the provider role", async (_name, role) => {
		const { response, users, context, next, db } =
			await provisionFirstExternalUser(role);
		expect(response.status).toBe(200);
		expect(users).toHaveLength(1);
		expect(users[0]?.role).toBe(role);
		expect(context.locals.user?.role).toBe(role);
		expect(next).toHaveBeenCalledOnce();
		expect(db.selectFrom).not.toHaveBeenCalled();
	});
});
