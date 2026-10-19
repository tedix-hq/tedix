import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import { needsYou } from "./needs-you";
import { ORGANIZATION_PROBE, type HookDeps } from "./hook-io";
import { runPromptContext } from "./prompt-context";
import { runSessionStart } from "./session-start";

const organizationId = "11111111-1111-4111-8111-111111111111";
const session = "22222222-2222-4222-8222-222222222222";
const binding = {
	status: "bound",
	workspace: "fictional",
	org: "org_fictional",
	organization: "org_fictional",
	mcpUrl: "https://fictional.example.invalid/mcp",
	root: process.cwd(),
	projectId: organizationId,
};
const auth = {
	workspace: binding.workspace,
	mcpUrl: binding.mcpUrl,
	wouldUse: "stored-login",
	storedLogin: {
		loginId: "fictional-user",
		org: binding.org,
		accessToken: { selectedOrganizations: [binding.org] },
	},
};
const card = (n: number): DeckCard => ({
	id: `factory:${organizationId}:${n}`,
	kind: "factory",
	label: "Choose the draft",
	project: "Example",
	urgency: "today",
	decision: null,
	source: "Example source",
	requestedAt: "2026-10-19T12:00:00Z",
	dueAt: null,
	score: 100 - n,
	factory: {
		outputId: organizationId,
		sourceIndex: 0,
		rowIndex: n,
		revision: 1,
		draft: "Private draft excluded",
		why: "The review window closes today",
		sourceText: "Private source excluded",
	},
});
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "tedix-needs-you-"));
	directories.push(dir);
	let cards = [card(1)];
	let org = organizationId;
	const calls: string[][] = [];
	const outputs: string[] = [];
	const deps: HookDeps = {
		env: { TEDIX_CONFIG_DIR: dir },
		cwd: process.cwd(),
		stdin: JSON.stringify({ session_id: session, source: "startup" }),
		write: (line) => outputs.push(line),
		read: async (args) => {
			calls.push(args);
			if (args.includes("show")) return { ...binding };
			if (args.includes("auth")) return auth;
			if (args.includes(ORGANIZATION_PROBE)) return { organizationId: org };
			if (args.includes("deck"))
				return {
					cards,
					count: cards.length,
					complete: true,
					observedAt: "2026-10-19T12:00:00Z",
				};
			throw new Error("Unrelated source unavailable");
		},
	};
	return {
		deps,
		dir,
		calls,
		outputs,
		cards: (value: DeckCard[]) => {
			cards = value;
		},
		org: (value: string) => {
			org = value;
		},
		read: (target = binding, user = auth) =>
			needsYou(
				deps,
				target,
				user,
				["-w", target.workspace, "--organization", target.organization],
				session,
			),
	};
}

test("new cards appear once, only after delivery, without storing card text", async () => {
	const f = fixture();
	const first = await f.read();
	expect(first?.text).toContain("why now:");
	expect(first?.text).toContain("#card=factory%3A");
	expect(first?.text).toContain("show_deck");
	expect((await f.read())?.text).toBe(first?.text);
	first?.delivered();
	expect(await f.read()).toBeUndefined();
	f.cards([card(1), card(2)]);
	expect((await f.read())?.text.match(/- Ask:/g)).toHaveLength(1);
	const receipt = readFileSync(
		join(f.dir, "hook-cache", readdirSync(join(f.dir, "hook-cache"))[0]!),
		"utf8",
	);
	expect(receipt).not.toContain("Choose");
	expect(receipt).not.toContain(organizationId);
});

test("quiet and explicit opt-out skip all reads", async () => {
	for (const value of ["0", "false", "quiet", "off"]) {
		const f = fixture();
		f.deps.env.TEDIX_NEEDS_YOU = value;
		expect(await f.read()).toBeUndefined();
		expect(f.calls).toHaveLength(0);
	}
});

test("empty, unavailable and malformed Deck states stay silent", async () => {
	const f = fixture();
	f.cards([]);
	expect(await f.read()).toBeUndefined();
	f.deps.read = async () => {
		throw new Error("Unavailable");
	};
	expect(await f.read()).toBeUndefined();
	f.deps.read = async (args) =>
		args.includes(ORGANIZATION_PROBE)
			? { organizationId }
			: { cards: [card(1)] };
	expect(await f.read()).toBeUndefined();
});

test("at most three ranked cards and five lines fit 1800 UTF-8 bytes; secrets and private bodies stay out", async () => {
	const f = fixture();
	f.cards(
		Array.from({ length: 8 }, (_, n) => ({
			...card(n),
			label: `token=supersecretvalue123\n${"🛰️".repeat(500)}`,
		})),
	);
	const block = (await f.read())!.text;
	expect(block.match(/- Ask:/g)!.length).toBeLessThanOrEqual(3);
	expect(block.split("\n").length).toBeLessThanOrEqual(5);
	expect(Buffer.byteLength(block)).toBeLessThanOrEqual(1800);
	expect(block).toContain("[redacted]");
	expect(block).not.toContain("supersecretvalue123");
	expect(block).not.toContain("Private");
});

test("fresh active org and user scope isolate dedupe, including switching back", async () => {
	const f = fixture();
	(await f.read())?.delivered();
	const other = { ...binding, org: "org_other", organization: "org_other" };
	f.org("33333333-3333-4333-8333-333333333333");
	expect((await f.read(other))?.text).toContain("Needs you");
	expect(f.calls.at(-1)).toContain("org_other");
	f.org(organizationId);
	expect(await f.read()).toBeUndefined();
	expect(
		await f.read(binding, {
			...auth,
			storedLogin: { ...auth.storedLogin, loginId: "another-user" },
		}),
	).toBeDefined();
	f.deps.env.TEDIX_ORGANIZATION = "org_other";
	const count = f.calls.length;
	expect(await f.read()).toBeUndefined();
	expect(f.calls).toHaveLength(count);
});

test.each(["claude-code", "codex", "devin"])(
	"%s startup and prompt share receipts; quiet startup is silent",
	async (host) => {
		const f = fixture();
		if (host === "codex") f.deps.env.CODEX_THREAD_ID = session;
		if (host === "devin") f.deps.env.TEDIX_HOOK_HOST = "devin";
		await runSessionStart(f.deps);
		expect(f.outputs[0]).toContain("Needs you");
		await runPromptContext(f.deps);
		expect(f.outputs.at(-1)).not.toContain("Needs you");
		f.cards([card(2)]);
		await runPromptContext(f.deps);
		expect(f.outputs.at(-1)).toContain("Needs you");
		const quiet = fixture();
		quiet.deps.env.TEDIX_PLUGIN_PREFLIGHT = "0";
		await runSessionStart(quiet.deps);
		await runPromptContext(quiet.deps);
		expect(quiet.outputs).toHaveLength(0);
	},
);
