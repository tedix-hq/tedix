import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeWorkspaceCredentials } from "../credential-store";
import { readHookCommand } from "./command";

test("hook auth reads inspect fresh credentials without a child or cached authority", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tedix-hook-auth-"));
	const keys = [
		"TEDIX_CONFIG_DIR",
		"TEDIX_EXTERNAL_AGENT",
		"TEDIX_AGENT_SESSION",
		"TEDIX_MCP_BEARER_TOKEN",
		"TEDIX_MCP_API_KEY",
	];
	const previous = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		process.env.TEDIX_CONFIG_DIR = dir;
		const write = (organization: string) =>
			writeWorkspaceCredentials(
				"fixture",
				{
					loginId: "fictional-owner",
					org: organization,
					mcpUrl: "https://connect.mcp.tedix.dev/mcp",
					oauthTokens: {
						access_token: `e30.${Buffer.from(JSON.stringify({ tedixSelectedOrganizations: [organization], scope: "mcp:work.read" })).toString("base64url")}.PRIVATE_SIGNATURE`,
						token_type: "Bearer",
					},
				},
				{ configDir: dir },
			);
		write("org_orchid");
		// A subprocess cannot run with a zero deadline; this is a local snapshot.
		const args = ["-w", "fixture", "auth", "status", "--json"];
		const first = await readHookCommand(args, 0, undefined, {
			cwd: process.cwd(),
		});
		expect(first).toMatchObject({
			workspace: "fixture",
			mcpUrl: "https://connect.mcp.tedix.dev/mcp",
			wouldUse: "stored-login",
			storedLogin: {
				org: "org_orchid",
				accessToken: { selectedOrganizations: ["org_orchid"] },
			},
		});
		expect(JSON.stringify(first)).not.toContain("PRIVATE_SIGNATURE");
		write("org_cedar");
		expect(
			(await readHookCommand(args, 0)).storedLogin.accessToken
				.selectedOrganizations,
		).toEqual(["org_cedar"]);
		process.env.TEDIX_MCP_API_KEY = "sk_fictional_rejected_key";
		await expect(readHookCommand(args, 0)).rejects.toThrow(
			"must be a Tedix Unified MCP JWT",
		);
		delete process.env.TEDIX_MCP_API_KEY;
		await expect(
			readHookCommand(args, 0, undefined, { cwd: dir }),
		).rejects.toThrow("Invalid CLI read timeout");
		await expect(
			readHookCommand(args, 0, undefined, { env: { TEDIX_CONFIG_DIR: dir } }),
		).rejects.toThrow("Invalid CLI read timeout");
		await expect(readHookCommand([...args, "--unknown"], 0)).rejects.toThrow(
			"Invalid CLI read timeout",
		);
	} finally {
		keys.forEach((key, i) => {
			if (previous[i] === undefined) delete process.env[key];
			else process.env[key] = previous[i];
		});
		rmSync(dir, { recursive: true, force: true });
	}
});
