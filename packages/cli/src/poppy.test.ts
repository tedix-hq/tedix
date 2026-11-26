import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parseOptions } from "./options";
import { runPoppyCommand } from "./poppy";
import { SIMULATED_PERSONAL_AGENT_IDENTITIES } from "@tedix/auth/personal-agent-client";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("tedix poppy", () => {
	it("parses poppy flags only for the poppy command", () => {
		const parsed = parseOptions([
			"poppy",
			"call",
			"--company",
			"company.example",
			"--identity",
			"simulated-amber-otter",
			"--unsigned",
		]);
		expect(parsed.command).toBe("poppy");
		expect(parsed.options.poppy).toMatchObject({
			company: "company.example",
			identity: "simulated-amber-otter",
			unsigned: true,
		});
		expect(parsed.options.positionals).toEqual(["call"]);
		expect(() => parseOptions(["work", "list", "--unsigned"])).toThrow();
	});

	it("lists the simulated identities", async () => {
		const code = await runPoppyCommand({
			json: true,
			positionals: ["identities"],
			poppy: {},
		});
		expect(code).toBe(0);
		expect(SIMULATED_PERSONAL_AGENT_IDENTITIES.length).toBeGreaterThanOrEqual(
			3,
		);
		for (const identity of SIMULATED_PERSONAL_AGENT_IDENTITIES)
			expect(identity.name).toMatch(/^Simulated /);
	});

	it("keygen writes a private JWK and prints public documents", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-poppy-"));
		dirs.push(dir);
		const keyFile = join(dir, "agent.json");
		const logs: string[] = [];
		const original = console.log;
		console.log = (value: unknown) => logs.push(String(value));
		try {
			const code = await runPoppyCommand({
				json: true,
				positionals: ["keygen"],
				poppy: {
					keyFile,
					clientId: "https://agent.example/agent.json",
				},
			});
			expect(code).toBe(0);
		} finally {
			console.log = original;
		}
		const privateJwk = JSON.parse(readFileSync(keyFile, "utf8"));
		expect(privateJwk).toMatchObject({ kty: "EC", crv: "P-256" });
		expect(privateJwk.d).toBeTruthy();
		const out = JSON.parse(logs[0]!);
		expect(out.metadata).toEqual({
			client_id: "https://agent.example/agent.json",
			jwks_uri: "https://agent.example/jwks.json",
		});
		expect(out.jwks.keys[0]).not.toHaveProperty("d");
	});
});
