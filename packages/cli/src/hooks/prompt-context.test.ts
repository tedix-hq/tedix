import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./hook-io";
import {
	branchTopics,
	gatewayCode,
	repoSlug,
	runPromptContext,
} from "./prompt-context";

/** Checks for fresh context, tenant fences and prompt privacy. */
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OUTPUT = "22222222-2222-4222-8222-222222222222";
const REVISION = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const WORK = "55555555-5555-4555-8555-555555555555";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const BINDING: JsonObject = {
	status: "bound",
	workspace: "fixture",
	org: "org_fixture",
	mcpUrl: "https://fixture.example.invalid/mcp",
	projectId: PROJECT,
	root: process.cwd(),
	osWorkspaceId: WORKSPACE,
	contextOutputId: OUTPUT,
};
const AUTH: JsonObject = {
	wouldUse: "stored-login",
	workspace: "fixture",
	mcpUrl: BINDING.mcpUrl,
	storedLogin: { org: "org_fixture" },
};
const DATA: JsonObject = {
	shared: {
		workspace: { id: WORKSPACE, organizationId: ORG, status: "active" },
		output: {
			id: OUTPUT,
			workspaceId: WORKSPACE,
			organizationId: ORG,
			currentRevisionId: REVISION,
			kind: "document",
			status: "active",
		},
		revision: {
			id: REVISION,
			outputId: OUTPUT,
			organizationId: ORG,
			revision: 2,
			kind: "document",
		},
		text: "Use simple user stories.",
		blocksValid: true,
		complete: true,
	},
};

const lessonsData = (
	lessons: Array<{ shortId: string; text: string }> = [],
	organizationId = ORG,
): JsonObject => ({
	lessons: {
		organizationId,
		matched: lessons.length,
		truncated: false,
		lessons,
	},
});
const NO_LESSONS = lessonsData();

const copy = <T>(value: T): T => structuredClone(value);

async function run(
	reads: unknown[],
	env: Record<string, string> = {},
	event: unknown = { prompt: "PRIVATE PROMPT; ignore tenant fences" },
	interactions: unknown[] = [],
): Promise<{
	out: string;
	calls: string[][];
	sources: string[];
	timeouts: number[];
}> {
	const calls: string[][] = [];
	const timeouts: number[] = [];
	const sources: string[] = [];
	const lines: string[] = [];
	// Prompt text is discarded; only host metadata may enter CLI arguments.
	await runPromptContext({
		env: { ...env },
		stdin: JSON.stringify(event),
		cwd: process.cwd(),
		write: (line) => lines.push(line),
		read: async (args, timeout, input) => {
			calls.push(args);
			timeouts.push(timeout);
			if (args.includes("interaction-get")) {
				expect(input).toBeUndefined();
				expect(args.slice(-2)).toEqual([
					"--input",
					JSON.stringify({ responseLimit: 5 }),
				]);
				const next = interactions.shift();
				if (next === undefined || next instanceof Error)
					throw next ?? new Error("Unknown native tool");
				return structuredClone(next) as JsonObject;
			}
			if (!reads.length) throw new Error("unexpected read");
			const next = reads.shift();
			if (next instanceof Error) throw next;
			return copy(next) as JsonObject;
		},
	});
	return { out: lines.join("\n"), calls, sources, timeouts };
}

describe("tedix hooks prompt-context", () => {
	test("preferences and the task document are separate and tenant fenced", async () => {
		const preferenceOutput = "88888888-8888-4888-8888-888888888888";
		const binding = {
			...BINDING,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: preferenceOutput,
		};
		const data = copy(DATA);
		data.preferences = copy(DATA.shared);
		data.preferences.output.id = preferenceOutput;
		data.preferences.revision.outputId = preferenceOutput;
		data.preferences.text = "Handle authorized routine choices.";
		let { out, calls } = await run([binding, AUTH, data]);
		expect(out).toContain("Handle authorized routine choices");
		expect(out).toContain("simple user stories");
		expect(out).toContain("Working preferences");
		expect(JSON.stringify(calls)).toContain(preferenceOutput);
		data.preferences.workspace.organizationId = OUTPUT;
		data.preferences.output.organizationId = OUTPUT;
		data.preferences.revision.organizationId = OUTPUT;
		({ out } = await run([binding, AUTH, data]));
		expect(out).toContain("unavailable");
		expect(out).not.toContain("Handle authorized routine choices");
	});

	test("preferences reach a new chat without a task document", async () => {
		const { contextOutputId: _o, osWorkspaceId: _w, ...rest } = BINDING;
		const binding = {
			...rest,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: OUTPUT,
		};
		const { out } = await run([binding, AUTH, { preferences: DATA.shared }]);
		expect(out).toContain("Working preferences");
		expect(out).toContain("simple user stories");
	});

	test("approved team lessons come from Tedix memory for this repo, host and branch", async () => {
		const { contextOutputId: _o, osWorkspaceId: _w, ...rest } = BINDING;
		const binding = {
			...rest,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: OUTPUT,
			origin: "https://x-token:secret@github.com/Tedix-HQ/tedix.git",
			branch: "codex/ops-overlay-binding-4faadb1d",
		};
		const data: JsonObject = {
			preferences: copy(DATA.shared),
			...lessonsData([
				{
					shortId: "abcd1234",
					text: "Avoid changing a binding without the ops overlay edit.",
				},
				{ shortId: "ef567890", text: "Pushes race on main." },
			]),
		};
		let { out, calls } = await run(
			[binding, AUTH, data],
			{},
			{
				session_id: "77777777-7777-4777-8777-777777777777",
				prompt: "PRIVATE PROMPT",
			},
		);
		let text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(text).toContain("Working preferences");
		expect(text).toContain("Team lessons: 2 of 2 approved");
		expect(text).toContain("[abcd1234] Avoid changing a binding");
		expect(text).toContain("[ef567890] Pushes race on main.");
		expect(text.indexOf("Working preferences")).toBeLessThan(
			text.indexOf("Team lessons"),
		);
		const source = calls.at(-1)!.at(-1)!;
		expect(source).toContain("agent.get_agent_session_lessons");
		expect(source).toContain('"harness":"claude-code"');
		expect(source).toContain('"repo":"github.com/tedix-hq/tedix"');
		expect(source).toContain('"topics":["ops","overlay","binding"]');
		// Credentials in the origin URL and prompt text never leave the machine.
		expect(source).not.toContain("secret");
		expect(source).not.toContain("prompt");
		expect(JSON.stringify(calls)).not.toContain("PRIVATE PROMPT");
		// Codex is recognized from its turn metadata.
		({ calls } = await run(
			[binding, AUTH, data],
			{},
			{
				session_id: "77777777-7777-4777-8777-777777777777",
				turn_id: "turn-1",
			},
		));
		expect(calls.at(-1)!.at(-1)!).toContain('"harness":"codex"');
		// Lessons from another organization hide every body.
		({ out } = await run([
			binding,
			AUTH,
			{ ...data, ...lessonsData([], OUTPUT) },
		]));
		text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(text).toContain("unavailable");
		expect(text).not.toContain("simple user stories");
		// A malformed lesson is rejected, not shown.
		({ out } = await run([
			binding,
			AUTH,
			{
				...data,
				...lessonsData([{ shortId: "bad id!", text: "x" }]),
			},
		]));
		expect(out).toContain("Tedix shared context unavailable");
	});

	test("an unreadable lessons call leaves preferences injected", async () => {
		const binding = {
			...BINDING,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: OUTPUT,
		};
		// The gateway source itself catches the per-source failure.
		const project = new Function(
			"os",
			"work",
			"agent",
			`return (${gatewayCode(binding, { harness: "claude-code", topics: [] })})();`,
		) as (os: unknown, work: unknown, agent: unknown) => Promise<JsonObject>;
		const data = await project(
			{
				get_os_workspace: async () => ({ workspace: DATA.shared.workspace }),
				get_os_output: async () => ({
					output: DATA.shared.output,
					currentRevision: {
						...DATA.shared.revision,
						content: {
							kind: "document",
							blocks: [{ type: "paragraph", text: "Use simple user stories." }],
						},
					},
				}),
			},
			{},
			{
				get_agent_session_lessons: async () => {
					throw new Error("FORBIDDEN: Missing MCP capability mapping");
				},
			},
		);
		expect(data.lessons).toEqual({ unavailable: true });
		const { out } = await run([binding, AUTH, data]);
		const text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(text).toContain("Working preferences: Output=");
		expect(text).toContain("simple user stories");
		expect(text).toContain("Team lessons unavailable:");
		expect(text).not.toContain("FORBIDDEN");
		expect(text).not.toContain("Tedix shared context unavailable");
		// A forbidden Work read is named the same way.
		const withWork = await run([
			{ ...binding, workItemId: WORK },
			AUTH,
			{ ...data, work: { unavailable: true } },
		]);
		expect(withWork.out).toContain(`Selected Work=${WORK} unavailable`);
		expect(withWork.out).toContain("simple user stories");
		// Every source unreadable keeps the single unavailable message.
		const none = await run([
			{ ...binding, workItemId: WORK },
			AUTH,
			{
				shared: { unavailable: true },
				preferences: { unavailable: true },
				lessons: { unavailable: true },
				work: { unavailable: true },
			},
		]);
		expect(none.out).toContain("Tedix shared context unavailable");
		expect(none.out).not.toContain("Working preferences");
		// A gateway that returns lessons projects only id and text.
		const projected = await project(
			{},
			{},
			{
				get_agent_session_lessons: async (input: JsonObject) => {
					expect(input).toEqual({ harness: "claude-code", budgetBytes: 2800 });
					return {
						organizationId: ORG,
						matched: 1,
						truncated: false,
						lessons: [
							{
								id: "full-id",
								shortId: "abcd1234",
								kind: "prefer",
								text: "t",
								repos: ["r"],
							},
						],
					};
				},
			},
		);
		expect(projected.lessons).toEqual({
			organizationId: ORG,
			matched: 1,
			truncated: false,
			lessons: [{ shortId: "abcd1234", text: "t" }],
		});
	});

	test("lessons alone reach a chat with no selection and stay under the byte cap", async () => {
		const binding = {
			...BINDING,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: OUTPUT,
		};
		const big = (text: string) => {
			const doc = copy(DATA.shared);
			doc.text = text.repeat(3200);
			return doc;
		};
		const { out } = await run([
			binding,
			AUTH,
			{
				shared: big("s"),
				preferences: big("p"),
				...lessonsData(
					Array.from({ length: 5 }, (_, n) => ({
						shortId: `0000000${n}`,
						text: "l".repeat(560),
					})),
				),
			},
		]);
		const text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(9600);
		expect(text).toContain("complete=false");
		const { contextOutputId: _o, osWorkspaceId: _w, ...rest } = BINDING;
		const { out: only } = await run([
			rest,
			AUTH,
			lessonsData([{ shortId: "abcd1234", text: "Small commits." }]),
		]);
		expect(only).toContain("[abcd1234] Small commits.");
		expect(only).not.toContain("Working preferences");
		// No approved lesson and nothing selected: nothing is injected.
		const { out: quiet, calls } = await run([rest, AUTH, NO_LESSONS]);
		expect([quiet, calls.length]).toEqual(["", 3]);
	});

	test("repo slugs drop credentials and branch topics drop ids", () => {
		expect(repoSlug("git@github.com:tedix-hq/tedix.git")).toBe(
			"github.com/tedix-hq/tedix",
		);
		expect(repoSlug("https://user:pw@GitHub.com/tedix-hq/tedix/")).toBe(
			"github.com/tedix-hq/tedix",
		);
		expect(repoSlug("not a url")).toBeUndefined();
		expect(repoSlug(undefined)).toBeUndefined();
		expect(branchTopics("codex/work-42229a0e-7e54f207-deploy-gate")).toEqual([
			"deploy",
			"gate",
		]);
	});

	test("connect routes the selected org and uses the live UUID for ownership", async () => {
		const binding = {
			...BINDING,
			workspace: "connect",
			org: "org_target",
			organization: "org_target",
			mcpUrl: "https://connect.mcp.tedix.dev/mcp",
		};
		const auth = {
			wouldUse: "stored-login",
			workspace: "connect",
			mcpUrl: binding.mcpUrl,
			storedLogin: {
				org: "incidental",
				accessToken: { selectedOrganizations: ["org_target"] },
			},
		};
		let { out, calls } = await run([
			binding,
			auth,
			{ organizationId: ORG },
			DATA,
		]);
		expect(out).toContain("simple user stories");
		expect(calls[2]!.slice(2, 4)).toEqual(["--organization", "org_target"]);
		expect(calls[3]!.slice(2, 4)).toEqual(["--organization", "org_target"]);
		const wrong = copy(DATA);
		for (const row of [
			wrong.shared.workspace,
			wrong.shared.output,
			wrong.shared.revision,
		])
			row.organizationId = WORK;
		({ out } = await run([binding, auth, { organizationId: ORG }, wrong]));
		expect(out).toContain("unavailable");
		expect(out).not.toContain("simple user stories");
		({ out, calls } = await run([
			binding,
			{
				...auth,
				storedLogin: { accessToken: { selectedOrganizations: ["other"] } },
			},
		]));
		expect(out).toContain("unavailable");
		expect(calls).toHaveLength(2);
		({ out, calls } = await run([binding, auth, { organizationId: null }]));
		expect(out).toContain("unavailable");
		expect(calls).toHaveLength(3);
	});

	test("host session metadata reaches the resolver without prompt text", async () => {
		const session = "77777777-7777-4777-8777-777777777777";
		const { out, calls } = await run(
			[{ ...BINDING, contextSessionId: session }, AUTH, DATA],
			{},
			{ session_id: session, prompt: "PRIVATE PROMPT" },
		);
		expect(calls[0]!.slice(-2)).toEqual(["--session", session]);
		expect(out).toContain("simple user stories");
		expect(JSON.stringify(calls) + out).not.toContain("PRIVATE PROMPT");
	});

	test("environment identity is preserved and normalized", async () => {
		const session = "abcdefab-7777-4777-8777-777777777777";
		const { out, calls } = await run(
			[{ ...BINDING, contextSessionId: session }, AUTH, DATA],
			{ CODEX_THREAD_ID: session.toUpperCase(), CODEX_SESSION_ID: session },
		);
		expect(calls[0]!.slice(-2)).toEqual(["--session", session]);
		expect(out).toContain("simple user stories");
	});

	test("conflicting, malformed and oversized events skip all reads", async () => {
		for (const [event, env] of [
			[{ session_id: "bad" }, {}],
			[{ session_id: WORK }, { CODEX_THREAD_ID: OUTPUT }],
			[{ session_id: WORK, prompt: "x".repeat(1_048_576) }, {}],
		] as const) {
			const { out, calls } = await run([], env, event);
			expect(out).toContain("unavailable");
			expect(calls).toEqual([]);
		}
	});

	test("a resolved other chat cannot reach the gateway", async () => {
		const { out, calls } = await run(
			[{ ...BINDING, contextSessionId: OUTPUT }],
			{},
			{ session_id: WORK },
		);
		expect(out).toContain("unavailable");
		expect(calls).toHaveLength(1);
	});

	test("unconfigured and disabled sessions have no gateway read", async () => {
		let { out, calls } = await run([{ status: "unbound" }]);
		expect(out).toBe("");
		expect(calls).toHaveLength(1);
		({ out, calls } = await run([], { TEDIX_PLUGIN_PREFLIGHT: "0" }));
		expect([out, calls.length]).toEqual(["", 0]);
		// A bound chat always asks for lessons; with none and nothing else, nothing is injected.
		const { contextOutputId: _o, osWorkspaceId: _w, ...empty } = BINDING;
		({ out, calls } = await run([empty, AUTH, NO_LESSONS]));
		expect([out, calls.length]).toEqual(["", 3]);
		// The gateway read gets what the hook's budget leaves, never less than 8s.
		const fast = await run([BINDING, AUTH, DATA]);
		expect(fast.timeouts.at(-1)!).toBeGreaterThan(12_000);
		expect(fast.timeouts.at(-1)!).toBeLessThanOrEqual(13_500);
		// Beside a document, an empty lessons read is named rather than silent.
		({ out } = await run([BINDING, AUTH, { ...DATA, ...NO_LESSONS }]));
		expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain(
			"Team lessons: none approved for this repository and host.",
		);
	});

	test("fresh delivery and revision change without prompt capture", async () => {
		const { out: first, calls } = await run([BINDING, AUTH, DATA]);
		const message = JSON.parse(first).hookSpecificOutput;
		expect(message.hookEventName).toBe("UserPromptSubmit");
		expect(message.additionalContext).toContain("simple user stories");
		expect(first).toContain(REVISION);
		expect(JSON.stringify(calls) + first).not.toContain("PRIVATE PROMPT");
		expect(calls.at(-1)!.slice(0, 3)).toEqual(["-w", "fixture", "code"]);
		const changed = copy(DATA);
		changed.shared.revision.revision = 3;
		changed.shared.text = "New agreed decision";
		const { out: second } = await run([BINDING, AUTH, changed]);
		expect(second).toContain("New agreed decision");
		expect(second).not.toContain("simple user stories");
		const { out: repeated } = await run([BINDING, AUTH, changed]);
		expect(repeated).toContain("New agreed decision");
	});

	test("a bad binding, profile, gateway or auth does not read content", async () => {
		for (const changed of [
			{ ...BINDING, contextOutputId: "bad; shell" },
			{ ...BINDING, root: "/unrelated" },
			{ ...BINDING, status: "invalid" },
		]) {
			const { out, calls } = await run([changed]);
			expect(out).toContain("unavailable");
			expect(calls).toHaveLength(1);
		}
		for (const changed of [
			{ ...AUTH, mcpUrl: "https://other.example/mcp" },
			{ ...AUTH, wouldUse: "direct-token" },
			{ ...AUTH, storedLogin: { org: "org_other" } },
		]) {
			const { out, calls } = await run([BINDING, changed]);
			expect(out).toContain("unavailable");
			expect(calls).toHaveLength(2);
		}
		const { out, calls } = await run([BINDING], { TEDIX_WORKSPACE: "other" });
		expect(out).toContain("unavailable");
		expect(calls).toHaveLength(1);
	});

	test("a wrong workspace, org, output or revision hides all body", async () => {
		for (const [group, key] of [
			["workspace", "id"],
			["workspace", "organizationId"],
			["output", "workspaceId"],
			["revision", "outputId"],
			["revision", "id"],
		] as const) {
			const data = copy(DATA);
			data.shared[group][key] = "wrong";
			const { out } = await run([BINDING, AUTH, data]);
			expect(out).toContain("unavailable");
			expect(out).not.toContain("simple user stories");
		}
	});

	test("a timeout or missing revision never reuses a previous read", async () => {
		for (const error of [
			new Error("timed out"),
			new Error("denied"),
			{ shared: {} },
		]) {
			const { out } = await run([BINDING, AUTH, error]);
			expect(out).toContain("no current shared decision");
			expect(out).not.toContain("simple user stories");
		}
	});

	test("truncation and selected Work receipts", async () => {
		const data = copy(DATA);
		data.shared.text = "x".repeat(4000);
		const binding = { ...BINDING, workItemId: WORK };
		data.work = {
			item: {
				id: WORK,
				projectId: PROJECT,
				organizationId: ORG,
				disposition: "accepted",
			},
			comments: [
				{
					id: "receipt-1",
					workItemId: WORK,
					authorType: "external_agent",
					authorId: "reader",
					createdAt: "now",
					body: "y".repeat(500),
					complete: false,
				},
			],
			commentCount: 8,
		};
		let { out } = await run([binding, AUTH, data]);
		expect(out).toContain("truncated");
		expect(out).toContain("receipt-1");
		expect(out).toContain("reader");
		expect(out).not.toContain("x".repeat(3201));
		expect(out).not.toContain("y".repeat(401));
		data.work.item.projectId = "wrong";
		({ out } = await run([binding, AUTH, data]));
		expect(out).toContain("unavailable");
		expect(out).not.toContain("receipt-1");
	});

	test("the output byte cap prevents an oversized hook spill", async () => {
		const data = copy(DATA);
		data.shared.text = "𠮷".repeat(3200);
		const { out } = await run([BINDING, AUTH, data]);
		const text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(9600);
		expect(text).toContain("complete=false");
	});

	test("organization links are not invented", async () => {
		let { out } = await run([BINDING, AUTH, DATA]);
		expect(out).toContain(`Output=${OUTPUT}`);
		expect(out).not.toContain("tedix.os.tedix.dev");
		const missing = copy(DATA);
		delete missing.shared.blocksValid;
		({ out } = await run([BINDING, AUTH, missing]));
		expect(out).toContain("unavailable");
		expect(out).not.toContain("simple user stories");
	});

	test("the actual gateway projection rejects malformed blocks", async () => {
		const project = new Function(
			"os",
			`return (${gatewayCode(BINDING)})();`,
		) as (os: unknown) => Promise<JsonObject>;
		for (const blocks of <unknown[]>[
			undefined,
			{},
			[null],
			[{ type: "paragraph" }],
			[{ type: "list", items: "bad" }],
			[{ type: "list", items: [null] }],
			[{ type: "unknown", text: "secret" }],
			[],
			[
				{ type: "list", items: ["first", "second"] },
				{ type: "paragraph", text: "third" },
			],
		]) {
			const response: JsonObject = {
				output: DATA.shared.output,
				currentRevision: {
					...DATA.shared.revision,
					content: { kind: "document" },
				},
			};
			if (blocks !== undefined)
				response.currentRevision.content.blocks = blocks;
			const os = {
				get_os_workspace: async () => ({ workspace: DATA.shared.workspace }),
				get_os_output: async () => response,
			};
			const valid =
				Array.isArray(blocks) && (blocks.length === 0 || blocks.length === 2);
			const result = await project(os);
			// A malformed document is reported unavailable without its body.
			expect(result.shared.unavailable === true).toBe(!valid);
			if (!valid) expect(JSON.stringify(result)).not.toContain("secret");
			if (valid) {
				expect(result.shared.blocksValid).toBe(true);
				expect(result.shared.text).toBe(
					(blocks as unknown[]).length ? "first\nsecond\nthird" : "",
				);
			}
		}
	});

	test("the gateway source renders semantic blocks and limits its return", () => {
		const source = gatewayCode({ ...BINDING, workItemId: WORK });
		expect(source).toContain("get_os_workspace");
		expect(source).toContain("b.type === 'list' ? b.items");
		expect(source).toContain("slice(-2)");
		expect(source).toContain("authorId");
		expect(source).not.toContain("prompt");
	});

	test("the hook source never reads the prompt field", () => {
		// Only `session_id` and `source` leave the host event in read hooks.
		for (const file of ["./prompt-context.ts", "./session-start.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source).not.toMatch(/\.prompt\b|\["prompt"\]/);
		}
	});

	describe("decision-capture answers from Tedix OS", () => {
		const SESSION = "77777777-7777-4777-8777-777777777777";
		const REQUEST = "99999999-9999-4999-8999-999999999999";
		const DRAFT = "abababab-abab-4bab-8bab-abababababab";
		const CAPTURE = {
			status: "bound",
			workspace: "fixture",
			org: "org_fixture",
			mcpUrl: BINDING.mcpUrl,
			projectId: PROJECT,
			root: process.cwd(),
			decisionCapture: true,
			contextSessionId: SESSION,
		};
		const LOGIN = {
			...AUTH,
			storedLogin: { org: "org_fixture", loginId: "U-me" },
		};
		const detail = (overrides: JsonObject = {}): JsonObject => {
			const value: JsonObject = {
				request: {
					id: REQUEST,
					orgId: ORG,
					workItemId: null,
					caseId: null,
					projectId: PROJECT,
					kind: "question",
					subject: "Fixture decision",
					prompt: "Fixture question",
					requestedFromType: "user",
					requestedFromId: "U-me",
					creatorType: "user",
					creatorId: "U-me",
					creatorSessionId: null,
					state: "open",
					requestedAt: "2026-10-06T00:00:00Z",
					dueAt: null,
					expiresAt: null,
					resolvedAt: null,
					version: 2,
					metadata: {},
				},
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				latestDraft: {
					id: DRAFT,
					body: 'Yes, ship it. "Then" tidy docs.',
					rationale: "Routine follow-up.",
					drafterId: "tedi-docs",
					drafterName: null,
					createdAt: "2026-10-06T00:00:00Z",
					turnType: null,
					delivery: "review",
				},
				responses: { data: [], nextCursor: null, hasMore: false },
				...overrides,
			};
			value.responses.data = value.responses.data.map(
				(response: JsonObject) => ({
					id: "22222222-2222-4222-8222-222222222222",
					requestId: REQUEST,
					responseKind: "answer",
					artifactRef: null,
					artifactVersion: null,
					artifactDigest: null,
					respondedBySessionId: null,
					respondedAt: "2026-10-06T01:00:00Z",
					...response,
				}),
			);
			return value;
		};

		function withConfig(
			body: (config: string, dir: string) => Promise<void>,
		): Promise<void> {
			const config = mkdtempSync(join(tmpdir(), "tedix-prompt-"));
			const dir = join(config, "decision-capture");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `${SESSION}.question.json`),
				JSON.stringify({ requestId: REQUEST, token: "t", host: "codex" }),
			);
			return body(config, dir).finally(() =>
				rmSync(config, { recursive: true, force: true }),
			);
		}
		const context = (out: string) =>
			out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";

		test("an open question's tedi draft never reaches the session, even on ok", () =>
			withConfig(async (config, dir) => {
				for (const prompt of ["ok", "PRIVATE PROMPT"]) {
					const { out, calls, sources } = await run(
						[CAPTURE, LOGIN, NO_LESSONS],
						{ TEDIX_CONFIG_DIR: config },
						{ session_id: SESSION, prompt },
						[detail()],
					);
					expect(out).toBe("");
					expect(sources).toEqual([]);
					expect(
						calls.some(
							(args) =>
								args.includes("interaction-get") && args.includes(REQUEST),
						),
					).toBe(true);
					const files = readdirSync(dir)
						.map((name) => readFileSync(join(dir, name), "utf8"))
						.join("");
					expect(
						JSON.stringify(calls) + sources.join("") + files,
					).not.toContain("PRIVATE PROMPT");
					expect(files).not.toContain(DRAFT);
					// Still open: kept for the next prompt.
					expect(existsSync(join(dir, `${SESSION}.question.json`))).toBe(true);
				}
			}));

		test("an answer given in Tedix OS reaches the next prompt once", () =>
			withConfig(async (config, dir) => {
				const answered = detail({
					effectiveState: "resolved",
					responses: {
						data: [
							{
								body: "Hold the deploy.",
								resolvesRequest: true,
								respondedByType: "user",
								respondedById: "U-me",
								metadata: { source: "os-inbox" },
							},
						],
						nextCursor: null,
						hasMore: false,
					},
				});
				const { out } = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "status?" },
					[answered],
				);
				expect(context(out)).toBe(
					`The user replied in Tedix OS to Interaction ${REQUEST}: "Hold the deploy."`,
				);
				expect(existsSync(join(dir, `${SESSION}.question.json`))).toBe(false);
				const again = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "status?" },
					[answered],
				);
				expect(again.out).toBe("");
				expect(again.sources).toEqual([]);
			}));

		test("a tedi or another principal's answer is not delivered", () =>
			withConfig(async (config) => {
				for (const [byType, byId] of [
					["tedi", "tedi-docs"],
					["user", "U-other"],
				]) {
					const { out } = await run(
						[CAPTURE, LOGIN, NO_LESSONS],
						{ TEDIX_CONFIG_DIR: config },
						{ session_id: SESSION, prompt: "ok" },
						[
							detail({
								effectiveState: "resolved",
								responses: {
									data: [
										{
											body: "Not yours",
											resolvesRequest: true,
											respondedByType: byType,
											respondedById: byId,
											metadata: {},
										},
									],
									nextCursor: null,
									hasMore: false,
								},
							}),
						],
					);
					expect(out).not.toContain("Not yours");
				}
			}));

		test("missing tools, no question or no opt-in stay silent", () =>
			withConfig(async (config, dir) => {
				let { out, calls } = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "ok" },
					[new Error("Unknown tool")],
				);
				expect(out).toBe("");
				expect(calls).toHaveLength(4);
				({ out, calls } = await run(
					[{ ...CAPTURE, decisionCapture: false }, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "ok" },
				));
				expect([out, calls.length]).toEqual(["", 3]);
				({ out } = await run(
					[CAPTURE, { ...LOGIN, mcpUrl: "https://other.example/mcp" }],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "ok" },
				));
				expect(out).toContain("Tedix shared context unavailable");
				rmSync(join(dir, `${SESSION}.question.json`));
				({ out, calls } = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "ok" },
				));
				expect([out, calls.length]).toEqual(["", 3]);
			}));

		test("an OS answer follows the selected shared context", () =>
			withConfig(async (config) => {
				const { out } = await run(
					[{ ...BINDING, ...CAPTURE }, LOGIN, { ...DATA, ...NO_LESSONS }],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "status?" },
					[
						detail({
							effectiveState: "resolved",
							responses: {
								data: [
									{
										body: "Hold the deploy.",
										resolvesRequest: true,
										respondedByType: "user",
										respondedById: "U-me",
										metadata: { source: "os-inbox", draftId: DRAFT },
									},
								],
								nextCursor: null,
								hasMore: false,
							},
						}),
					],
				);
				const text = context(out);
				expect(text).toContain("simple user stories");
				expect(text.indexOf("simple user stories")).toBeLessThan(
					text.indexOf("replied in Tedix OS"),
				);
			}));
	});
});

describe("prompt-context outside a bound repository", () => {
	const DEFAULT: JsonObject = {
		status: "bound",
		contextSource: "default",
		workspace: "fixture",
		org: "org_fixture",
		mcpUrl: "https://fixture.example.invalid/mcp",
	};
	const additional = (out: string): string =>
		out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";

	test("reads the default organization's lessons with no repository", async () => {
		const { out, calls } = await run([
			DEFAULT,
			AUTH,
			lessonsData([{ shortId: "abcd1234", text: "Quote prices in EUR." }]),
		]);
		expect(calls[0]).toContain("--allow-default");
		const code = calls[2]!.at(-1)!;
		expect(code).toContain('"lessons":{"harness"');
		expect(code).not.toContain('"repo"');
		expect(code).not.toContain('"topics"');
		const text = additional(out);
		expect(text).toContain("no bound repository (default organization)");
		expect(text).toContain("outside any repository");
		expect(text).toContain("Quote prices in EUR.");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(6500);
	});

	test("stays silent with no lesson, and when no single organization resolves", async () => {
		expect((await run([DEFAULT, AUTH, NO_LESSONS])).out).toBe("");
		const { out, calls } = await run([{ status: "unbound" }]);
		expect(out).toBe("");
		expect(calls).toHaveLength(1);
	});

	test("never reads a selection a default context could carry", async () => {
		const { calls } = await run([
			{ ...DEFAULT, osWorkspaceId: WORKSPACE, contextOutputId: OUTPUT },
			AUTH,
			NO_LESSONS,
		]);
		expect(calls[2]!.at(-1)).not.toContain(OUTPUT);
	});
});
