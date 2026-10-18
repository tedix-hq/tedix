import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache } from "./context-cache";
import { gatewayCode, render, runPromptContext } from "./prompt-context";

const projectId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const session = "33333333-3333-4333-8333-333333333333";
const id = (n: number) =>
	`${String(n).padStart(8, "0")}-4444-4444-8444-444444444444`;
const now = new Date("2026-10-18T12:00:00Z");
const binding = {
	status: "bound",
	workspace: "fictional",
	org: "org_fictional",
	mcpUrl: "https://fictional.example.invalid/mcp",
	root: process.cwd(),
	projectId,
	credentialOrganizationId: organizationId,
};

test("board priorities exclude other harnesses, projects, selected and running Work", async () => {
	const rows = [
		{ id: id(1), metadata: { executor: "claude-code" } },
		{ id: id(2), metadata: {} },
		{ id: id(3), metadata: { executor: "human" } },
		{ id: id(4), metadata: { executor: "codex" } },
		{ id: id(5), projectId: id(9) },
		{ id: id(6) },
		{ id: id(7) },
		{ id: id(8) },
	].map((row) => ({
		title: "Fictional\npriority",
		orgId: organizationId,
		projectId,
		disposition: "accepted",
		...row,
	}));
	const code = gatewayCode({
		nextWork: { projectId, harness: "claude-code", selected: id(6) },
	});
	const execute = new Function("work", `return (${code})();`);
	const data = await execute({
		list_work_items: async (query: unknown) => {
			expect(query).toEqual({ projectId, disposition: "accepted", limit: 50 });
			return { data: rows };
		},
		list_work_item_cli_rows: async (query: unknown) => {
			expect(query).toEqual({
				projectId,
				disposition: "accepted",
				limit: 50,
				view: "board",
			});
			return {
				data: rows.map((row) => ({
					...row,
					activeAttempt:
						row.id === id(2) ? { agentSession: "another-chat" } : null,
				})),
			};
		},
	});
	expect(data.nextWork.data.map((row: { id: string }) => row.id)).toEqual([
		id(1),
		id(7),
		id(8),
	]);
	const lines = render(binding, data, now)
		.split("\n")
		.filter((line) => line.startsWith("Next for you:"));
	expect(lines).toHaveLength(3);
	expect(lines[0]).toContain(`(00000001) — \`tedix work start ${id(1)}\``);
	expect(lines[0]).toContain('"Fictional priority"');
	expect(
		render({ ...binding, credentialOrganizationId: id(9) }, data, now),
	).not.toContain("Next for you:");
});

test("priority cache expires after 30 seconds and never returns expired data", () => {
	const config = mkdtempSync(join(tmpdir(), "tedix-next-work-"));
	try {
		const env = { TEDIX_CONFIG_DIR: config };
		writeCache(env, "next-work", "scope", { data: [] }, now);
		expect(
			readCache(env, "next-work", "scope", new Date(+now + 30_000))?.fresh,
		).toBe(true);
		expect(
			readCache(env, "next-work", "scope", new Date(+now + 30_001)),
		).toBeUndefined();
		expect(readCache(env, "next-work", "other-project", now)).toBeUndefined();
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
});

test("fresh chat receives cached priorities; unavailable refresh omits them", async () => {
	const config = mkdtempSync(join(tmpdir(), "tedix-next-turn-"));
	let clock = now;
	let boardReads = 0;
	const outputs: string[] = [];
	try {
		const run = () =>
			runPromptContext({
				env: { TEDIX_CONFIG_DIR: config },
				cwd: process.cwd(),
				stdin: JSON.stringify({ session_id: session }),
				now: () => clock,
				write: (line) => outputs.push(line),
				read: async (args) => {
					if (args.includes("show")) return { ...binding };
					if (args.includes("auth"))
						return {
							workspace: binding.workspace,
							mcpUrl: binding.mcpUrl,
							wouldUse: "stored-login",
							storedLogin: { org: binding.org },
						};
					if (args.some((arg) => arg.includes('"nextWork":'))) boardReads++;
					return {
						lessons: { organizationId, lessons: [], matched: 0 },
						nextWork:
							boardReads > 1
								? { unavailable: true }
								: {
										data: [
											{
												id: id(1),
												title: "Fictional next action",
												projectId,
												organizationId,
											},
										],
									},
					};
				},
			});
		await run();
		await run();
		expect(boardReads).toBe(1);
		expect(
			outputs.slice(0, 2).every((output) => output.includes("Next for you:")),
		).toBe(true);
		clock = new Date(+now + 30_001);
		await run();
		expect(boardReads).toBe(2);
		expect(outputs[2]).not.toContain("Next for you:");
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
});
