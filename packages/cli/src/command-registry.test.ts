import { describe, expect, test } from "bun:test";
import {
	CLI_HELP_SCHEMA_VERSION,
	commandInventory,
	commandMap,
	findTopLevelCommand,
	machineHelp,
	rootHelp,
	topLevelHelp,
	TOP_LEVEL_COMMANDS,
} from "./command-registry";
import { COMMANDS } from "./commands";

describe("top-level command registry", () => {
	test("owns aliases and help without a parallel gateway catalog", () => {
		expect(findTopLevelCommand("start")?.name).toBe("chat");
		expect(findTopLevelCommand("rollback")?.name).toBe("rollback");
		expect(findTopLevelCommand("workspace")?.name).toBe("workspaces");
		expect(topLevelHelp("code")).toContain("Gateway-native steps");
		expect(topLevelHelp("tedi")).toContain("not the org gateway");
	});

	test("labels curated gateway recipes separately from direct Code Mode", () => {
		const surfaces = Object.fromEntries(
			TOP_LEVEL_COMMANDS.map(({ name, surface }) => [name, surface]),
		);
		expect(surfaces.code).toBe("gateway-direct");
		expect(surfaces.work).toBe("gateway-recipe");
		expect(surfaces.flow).toBe("gateway-recipe");
		expect(surfaces.skill).toBe("gateway-recipe");
		expect(surfaces.workflow).toBe("gateway-recipe");
		expect(surfaces.tedi).toBe("mixed");
		expect(surfaces.agent).toBe("mixed");
	});

	test("orients users by task and retains advanced discovery", () => {
		const help = rootHelp();
		expect(help.indexOf("Get started:")).toBeLessThan(
			help.indexOf("Work and automate:"),
		);
		for (const command of [
			"tedix login",
			"tedix ask",
			"tedix status",
			"tedix work",
			"tedix tedi",
			"tedix code",
			"tedix flow",
			"tedix skill",
			"tedix workflow",
			"tedix help --json",
			"tedix help exit-codes",
		]) {
			expect(help).toContain(command);
		}
		expect(help).not.toContain("gateway-recipe");
		expect(help).not.toContain("Mixed:");
		expect(commandMap()).toContain("discover.search");
		expect(commandMap()).toContain("includeParameters");
	});

	test("unifies top-level and direct Home commands without alias rows", () => {
		const shell = commandInventory().filter((row) => !row.interactiveOnly);
		expect(shell).toHaveLength(TOP_LEVEL_COMMANDS.length + COMMANDS.length);
		expect(new Set(shell.map((row) => row.name)).size).toBe(shell.length);
		expect(shell.some((row) => row.name === "run")).toBe(true);
		expect(shell.some((row) => row.name === "help")).toBe(true);
		expect(shell.some((row) => row.name === "ask")).toBe(false);
		expect(shell.find((row) => row.name === "chat")?.aliases).toContain("ask");
	});

	test("keeps same-named interactive overrides as distinct records", () => {
		const inventory = commandInventory();
		const shellRuns = inventory.find(
			(row) => row.name === "runs" && !row.interactiveOnly,
		);
		const interactiveRuns = inventory.find(
			(row) => row.name === "runs" && row.interactiveOnly,
		);
		expect(shellRuns?.invocation).toBe("tedix runs [conversationId]");
		expect(shellRuns?.availability).toEqual(["shell"]);
		expect(interactiveRuns?.invocation).toBe("/runs [prefix]");
		expect(interactiveRuns?.availability).toEqual(["interactive"]);
		expect(commandMap()).toContain(
			"Interactive-only slash commands (may override a same-named shell verb)",
		);
	});

	test("emits a versioned complete machine schema and resolves aliases", () => {
		const all = machineHelp();
		expect(all.schemaVersion).toBe(CLI_HELP_SCHEMA_VERSION);
		expect(all.cliVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(all.query.command).toBeNull();
		expect(all.dynamicAuthority.discovery).toContain("discover.search");
		expect(all.commands).toEqual(commandInventory());

		const ask = machineHelp("ask");
		expect(ask.query.command).toBe("chat");
		expect(ask.commands).toHaveLength(1);
		expect(ask.commands[0]?.name).toBe("chat");
		expect(ask.commands[0]?.exitCodes.map(({ code }) => code)).toEqual([
			0, 1, 2, 3,
		]);
		expect(() => machineHelp("missing-command")).toThrow("Unknown help topic");
		expect(machineHelp("rollback").commands[0]).toMatchObject({
			invocation: "tedix rollback",
			mutability: "write",
			name: "rollback",
		});
		expect(machineHelp("update").commands[0]?.mutability).toBe("mixed");
		expect(
			all.commands.find((row) => row.name === "help" && row.interactiveOnly)
				?.mutability,
		).toBe("read");
	});

	test("provides focused generic help for every shell command", () => {
		for (const command of commandInventory().filter(
			(row) => !row.interactiveOnly && !findTopLevelCommand(row.name)?.help,
		)) {
			const help = topLevelHelp(command.name);
			expect(help).toContain(command.name);
			expect(help.length).toBeLessThan(5_000);
		}
	});
});

test("machine help explains targets and consent while reusing authored syntax", () => {
	const help = machineHelp();
	expect(help.targeting.organizationEnvironment).toBe("TEDIX_ORGANIZATION");
	expect(help.targeting.precedence).toContain("overrides");
	expect(help.permissions.availableConnectScopes).toContain(
		"connections.execute",
	);
	expect(help.permissions.availableConnectScopes).not.toContain(
		"platform:admin",
	);
	expect(machineHelp("code").commands[0]?.targeting).toBe(
		"aggregate-or-organization",
	);
	expect(machineHelp("orgs").commands[0]?.targeting).toBe("account");
	expect(machineHelp("work").commands[0]?.targeting).toBe("organization");
	expect(machineHelp("tedi").commands[0]?.targeting).toBe("worker");
	expect(machineHelp("skill").commands[0]?.invocations).toContain(
		"tedix skill list [--limit <n>]",
	);
	expect(machineHelp("setup").commands[0]?.usage).toContain(
		"--organization <selected ID>",
	);
	expect(rootHelp()).toContain("TEDIX_ORGANIZATION");
});
