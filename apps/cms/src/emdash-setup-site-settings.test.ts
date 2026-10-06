import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// Execute the installed native route, isolating persistence and virtual seed
// dependencies. Upstream 3bfd6fc19 fixes setup losing to auto-seeded defaults.
const source = readFileSync(
	new URL(
		"../templates/tedix/node_modules/emdash/dist/astro/routes/api/setup/index.mjs",
		import.meta.url,
	),
	"utf8",
);
const start = source.indexOf("const POST = async (");
const end = source.indexOf("\n//#endregion", start);
if (start < 0 || end < 0) throw new Error("Native setup route missing");
const route = source
	.slice(start, end)
	.replaceAll("import.meta.env.DEV", "false");

function fixture(external = true, complete = true) {
	const options = new Map<string, unknown>([
		["site:title", "My Blog"],
		["site:tagline", "Template tagline"],
	]);
	let seedRuns = 0;
	const dependencies = {
		OptionsRepository: class {
			async get(key: string) {
				return options.get(key);
			}
			async set(key: string, value: unknown) {
				options.set(key, value);
			}
			async setIfAbsent(key: string, value: unknown) {
				if (!options.has(key)) options.set(key, value);
			}
		},
		getConfiguredOrigin: () => "https://example.com",
		parseBody: (request: Request) => request.json(),
		setupBody: {},
		isParseError: () => false,
		loadSeed: async () => ({ settings: { title: "My Blog" } }),
		validateSeed: () => ({ valid: true }),
		applySeedWithinBudget: async () => {
			seedRuns++;
			return { result: {}, complete, progress: {} };
		},
		SEED_BUDGET_PER_REQUEST: {},
		setSiteSettings: async (settings: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(settings))
				if (value !== undefined) options.set(`site:${key}`, value);
		},
		getAuthMode: () => ({ type: external ? "external" : "passkey" }),
		apiSuccess: (data: unknown) => Response.json({ data }),
		apiError: (code: string, message: string, status: number) =>
			Response.json({ code, message }, { status }),
		handleError: () => Response.json({}, { status: 500 }),
	};
	const post = new Function(
		...Object.keys(dependencies),
		`${route}\nreturn POST;`,
	)(...Object.values(dependencies)) as (context: unknown) => Promise<Response>;
	return {
		options,
		seedRuns: () => seedRuns,
		post: (title = "Chosen title", tagline = "Chosen tagline") =>
			post({
				request: new Request("https://example.com/_emdash/api/setup", {
					method: "POST",
					body: JSON.stringify({ title, tagline, includeContent: true }),
				}),
				url: new URL("https://example.com/_emdash/api/setup"),
				locals: { emdash: { db: {}, config: {} } },
			}),
	};
}

describe("native setup identity", () => {
	for (const external of [true, false])
		it(`overrides auto-seeded identity with ${external ? "external" : "passkey"} auth`, async () => {
			const f = fixture(external);
			expect((await f.post()).status).toBe(200);
			expect(f.options.get("site:title")).toBe("Chosen title");
			expect(f.options.get("site:tagline")).toBe("Chosen tagline");
		});
	it("waits for bounded seed completion before changing settings", async () => {
		const f = fixture(true, false);
		expect((await f.post()).status).toBe(200);
		expect(f.options.get("site:title")).toBe("My Blog");
		expect(f.options.get("emdash:setup_complete")).toBeUndefined();
	});
	it("rejects repeated setup before seeding or overwriting chosen settings", async () => {
		const f = fixture();
		await f.post();
		const res = await f.post("Replacement", "Replacement tagline");
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ code: "ALREADY_CONFIGURED" });
		expect(f.seedRuns()).toBe(1);
		expect(f.options.get("site:title")).toBe("Chosen title");
		expect(f.options.get("site:tagline")).toBe("Chosen tagline");
	});
});
