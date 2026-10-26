import { describe, expect, it, vi } from "vite-plus/test";
import app from "./demo-pack/opportunity-cards-app.json";

/**
 * The demo app's server module, loaded the way the app host loads it: as an
 * ES module with no imports. `App` receives the Durable Object context and an
 * env of the manifest config plus the role-scoped TEDIX capability.
 */
async function loadServer() {
	const module = (await import(
		/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(app["server.js"])}`
	)) as {
		App: new (
			ctx: unknown,
			env: unknown,
		) => {
			verdicts(): Promise<Record<string, { value: string }>>;
			recordVerdict(
				number: number | string,
				value: string,
			): Promise<{ number: string; value: string; storedIn: "sheet" | "app" }>;
		};
	};
	return module.App;
}

const sheet = {
	kind: "sheet",
	columns: ["#", "Source (link)", "Who", "Why (rule)", "Draft", "Useful?"],
	rows: [
		[1, "https://reddit.example/a", "Scout", "why a", "draft a", ""],
		[2, "https://reddit.example/b", "Scout", "why b", "draft b", ""],
	],
};

function harness(role: "use" | "owner") {
	const store = new Map<string, unknown>();
	const ctx = {
		storage: {
			kv: {
				get: (key: string) => store.get(key),
				put: (key: string, value: unknown) => store.set(key, value),
			},
		},
	};
	const outputsRead = vi.fn(async () => ({
		output: { id: "out-1", kind: "sheet" },
		revision: { revision: 4, content: structuredClone(sheet) },
	}));
	const outputsPatch = vi.fn(async () => ({ ok: true, revision: 5 }));
	const env = {
		CONFIG: {
			version: 1,
			settings: {
				slot: "opportunities",
				reviewer: "Maya",
				columns: { number: "#", useful: "Useful?" },
			},
		},
		// The host hands a use-role caller a capability without outputsPatch.
		TEDIX: role === "owner" ? { outputsRead, outputsPatch } : { outputsRead },
	};
	return { ctx, env, outputsRead, outputsPatch };
}

describe("Opportunity cards server", () => {
	it("writes a verdict into the granted sheet's row through the slot", async () => {
		const App = await loadServer();
		const { ctx, env, outputsRead, outputsPatch } = harness("owner");
		const server = new App(ctx, env);
		expect(await server.recordVerdict(2, "yes")).toEqual({
			number: "2",
			value: "yes",
			storedIn: "sheet",
		});
		expect(outputsRead).toHaveBeenCalledWith("opportunities", null);
		expect(outputsPatch).toHaveBeenCalledTimes(1);
		expect(outputsPatch).toHaveBeenCalledWith("opportunities", {
			kind: "sheet",
			startRow: 1,
			startColumn: 5,
			cells: [["yes"]],
			expectedRevision: 4,
		});
		expect(await server.verdicts()).toMatchObject({ "2": { value: "yes" } });
	});

	it("keeps the verdict in the app when the caller may only read", async () => {
		const App = await loadServer();
		const { ctx, env, outputsRead } = harness("use");
		const server = new App(ctx, env);
		expect(await server.recordVerdict(1, "no")).toMatchObject({
			storedIn: "app",
		});
		expect(outputsRead).not.toHaveBeenCalled();
		expect(await server.verdicts()).toMatchObject({ "1": { value: "no" } });
	});

	it("maps columns from the manifest settings and refuses unknown verdicts", async () => {
		const App = await loadServer();
		const { ctx, env, outputsPatch } = harness("owner");
		(env.CONFIG.settings.columns as Record<string, string>).useful =
			"Entscheidung";
		const server = new App(ctx, env);
		// The sheet has no such column: the verdict stays in the app, no write.
		expect(await server.recordVerdict(1, "yes")).toMatchObject({
			storedIn: "app",
		});
		expect(outputsPatch).not.toHaveBeenCalled();
		await expect(server.recordVerdict(1, "maybe")).rejects.toThrow(
			"Unknown verdict",
		);
	});
});
