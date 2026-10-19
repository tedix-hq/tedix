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
import {
	type Delegation,
	readDelegations,
	recordDelegation,
} from "../delegation-ledger";
import { workToolCall } from "./decision-capture";
import type { JsonObject } from "./hook-io";
import {
	branchTopics,
	gatewayCode,
	render,
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
		lessons: lessons.map((l) => ({
			...l,
			id: l.shortId,
			scope: { repo: "general", harness: "general", topic: "general" },
			updatedAt: null,
		})),
	},
});
const NO_LESSONS = lessonsData();

const copy = <T>(value: T): T => structuredClone(value);

async function run(
	reads: unknown[],
	env: Record<string, string> = {},
	event: unknown = { prompt: "PRIVATE PROMPT; ignore tenant fences" },
	interactions: unknown[] = [],
	/** Undelivered-answer pages; absent: an older server without the ledger. */
	undelivered: unknown[] = [],
	deferFailure = false,
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
	let catalog: JsonObject | undefined = (
		reads.find((r) => r && typeof r === "object" && "lessons" in r) as
			| JsonObject
			| undefined
	)?.lessons;
	// Prompt text stays local; only host metadata may enter CLI arguments.
	await runPromptContext({
		// Each run starts with an empty local cache unless the test shares one.
		env: {
			TEDIX_CONFIG_DIR: mkdtempSync(join(tmpdir(), "tedix-prompt-cache-")),
			...env,
		},
		stdin: JSON.stringify(event),
		cwd: process.cwd(),
		write: (line) => lines.push(line),
		deferRead: (args, input) => {
			calls.push([...args, input]);
			if (deferFailure) throw new Error("Measurement unavailable");
		},
		read: async (args, timeout, input) => {
			// Priority delivery has its own fixtures in prompt-next-work.test.ts.
			if (args.some((arg) => arg.includes('"nextWork":')))
				return { nextWork: { data: [] } };
			calls.push(args);
			timeouts.push(timeout);
			if (
				args.some((arg) =>
					arg.includes("list_undelivered_work_interaction_responses"),
				)
			) {
				const page = undelivered.shift();
				if (!page) throw new Error("Unknown native tool");
				return structuredClone(page) as JsonObject;
			}
			if (args.some((arg) => arg.includes("ack_work_interaction_delivery")))
				return { data: [] };
			if (args.some((arg) => arg.includes("get_work_interaction"))) {
				expect(input).toBeUndefined();
				expect(workToolCall(args)?.input.responseLimit).toBe(5);
				const next = interactions.shift();
				if (next === undefined || next instanceof Error)
					throw next ?? new Error("Unknown native tool");
				return structuredClone(next) as JsonObject;
			}
			if (args.some((a) => a.includes('"selectedLessonIds"'))) {
				if (!catalog) throw new Error("missing catalog fixture");
				return { lessons: copy(catalog) };
			}
			if (args.some((a) => a.includes('"catalog":true')))
				return { lessons: copy(catalog ?? NO_LESSONS.lessons) };
			if (!reads.length) throw new Error("unexpected read");
			const next = reads.shift();
			if (next instanceof Error) throw next;
			if (typeof next === "object" && next !== null && "lessons" in next)
				catalog = (next as JsonObject).lessons;
			return copy(next) as JsonObject;
		},
	});
	return { out: lines.join("\n"), calls, sources, timeouts };
}

describe("tedix hooks prompt-context", () => {
	test("measurement failure cannot replace freshly validated model context", async () => {
		const { out } = await run(
			[
				BINDING,
				AUTH,
				{
					...DATA,
					...lessonsData([{ shortId: "abcd1234", text: "Use short names." }]),
				},
			],
			{},
			{ session_id: "77777777-7777-4777-8777-777777777777", prompt: "Names" },
			[],
			[],
			true,
		);
		expect(out.split("\n")).toHaveLength(1);
		expect(out).toContain("Use short names.");
	});

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
		expect(source).toContain('"selectedLessonIds"');
		// The chat id lets the server record delivery and pick the holdout.
		expect(source).toContain(
			'"sessionId":"77777777-7777-4777-8777-777777777777"',
		);
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
		expect(text).not.toContain("Team lessons unavailable:");
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
		expect(none.out).not.toContain("Tedix shared context unavailable");
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
			holdout: false,
			lessons: [
				{
					id: "full-id",
					shortId: "abcd1234",
					text: "t",
					learned: undefined,
					scope: undefined,
					updatedAt: undefined,
				},
			],
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
					Array.from({ length: 8 }, (_, n) => ({
						shortId: `0000000${n}`,
						text: "l".repeat(560),
					})),
				),
			},
		]);
		const text = JSON.parse(out).hookSpecificOutput.additionalContext;
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(6400);
		// Lessons beyond the top six go before any document text.
		expect(text).toContain("Team lessons: 4 of 8 approved");
		expect(text).not.toContain("Context truncated");
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
		expect([
			JSON.parse(quiet).hookSpecificOutput.additionalContext.split("\n").length,
			calls.length,
		]).toEqual([1, 3]);
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
		// Probe, shared sources and catalog run together; a failed probe still hides everything.
		expect(calls).toHaveLength(5);
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
		expect([
			JSON.parse(out).hookSpecificOutput.additionalContext.split("\n").length,
			calls.length,
		]).toEqual([1, 3]);
		// The independent catalog gets 9s; validation uses only remaining host time.
		const fast = await run([BINDING, AUTH, DATA]);
		expect(fast.timeouts.at(-1)).toBe(9000);
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
			expect(out).not.toContain("simple user stories");
			expect(out).not.toContain("simple user stories");
		}
	});

	test("stays under the plugin's declared limit on both hosts, trimming lessons beyond the top six, then document tails", async () => {
		// The limit the plugin hook manifests (Claude source, Codex package) declare.
		const limit = JSON.parse(
			readFileSync(
				join(
					import.meta.dir,
					"../../../../plugins/tedix/config/host-hooks.json",
				),
				"utf8",
			),
		)
			.hooks.UserPromptSubmit.flatMap(
				(definition: { hooks: JsonObject[] }) => definition.hooks,
			)
			.find((handler: JsonObject) =>
				String(handler.command).endsWith("tedix hooks prompt-context"),
			).additionalContextLimit;
		expect(limit).toBe(10100);
		const preferenceOutput = "88888888-8888-4888-8888-888888888888";
		const binding = {
			...BINDING,
			preferencesWorkspaceId: WORKSPACE,
			preferencesOutputId: preferenceOutput,
		};
		const lessons = Array.from({ length: 10 }, (_, n) => ({
			shortId: `l${n}`,
			text: `Lesson ${n} ${"z".repeat(400)}`,
		}));
		const data = { ...copy(DATA), ...lessonsData(lessons) };
		data.shared.text = "s".repeat(3200);
		data.preferences = copy(DATA.shared);
		data.preferences.output.id = preferenceOutput;
		data.preferences.revision.outputId = preferenceOutput;
		data.preferences.text = "p".repeat(3200);
		const codexEvent = {
			session_id: "77777777-7777-4777-8777-777777777777",
			turn_id: "turn-1",
		};
		const top = ["l0", "l1", "l2", "l3", "l4", "l5"];
		// Claude Code and Codex share one budget below the declared limit.
		for (const event of [undefined, codexEvent]) {
			const { out } = await run([binding, AUTH, data], {}, event);
			const text = JSON.parse(out).hookSpecificOutput.additionalContext;
			expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(6400);
			expect(Buffer.byteLength(text, "utf8")).toBeLessThan(limit);
			// Lessons beyond the top six go first, then document tails; the top
			// lessons always survive and trimming never cuts mid-message.
			for (const id of top) expect(text).toContain(`[${id}]`);
			expect(text).not.toContain("[l6]");
			expect(text).toContain("Team lessons: 6 of 10 approved");
			expect(text).toContain("more were omitted for space");
			expect(text).toContain("complete=false");
			expect(text).toContain("Shared document is truncated");
			expect(text).not.toContain("Context truncated");
		}
		// The live shape: a 3 KB preferences document beside a full lesson set.
		const live = {
			...lessonsData(lessons.slice(0, 7)),
			preferences: { ...copy(data.preferences), text: "p".repeat(3034) },
		};
		const preferencesOnly = {
			...binding,
			osWorkspaceId: null,
			contextOutputId: null,
		};
		for (const event of [undefined, codexEvent]) {
			const { out } = await run([preferencesOnly, AUTH, live], {}, event);
			const text = JSON.parse(out).hookSpecificOutput.additionalContext;
			expect(Buffer.byteLength(text, "utf8")).toBeLessThan(limit);
			for (const id of top) expect(text).toContain(`[${id}]`);
			expect(text).not.toContain("Context truncated");
		}
		// Small context passes untouched.
		const small = JSON.parse(
			(
				await run(
					[
						BINDING,
						AUTH,
						{ ...copy(DATA), ...lessonsData(lessons.slice(0, 5)) },
					],
					{},
					codexEvent,
				)
			).out,
		).hookSpecificOutput.additionalContext;
		expect(small).toContain("Team lessons: 5 of 5 approved");
		expect(small).toContain("complete=true");
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

	test("local prompt ranking never puts prompt text in gateway code", () => {
		const source = gatewayCode(BINDING, {
			harness: "codex",
			topics: [],
			catalog: true,
		});
		expect(source).not.toContain("PRIVATE PROMPT");
		expect(source).not.toContain("event.prompt");
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

		test("every undelivered OS answer of the session reaches the next prompt and is recorded", () =>
			withConfig(async (config, dir) => {
				const answer = (
					requestId: string,
					responseId: string,
					body: string,
				) => ({
					responseId,
					requestId,
					subject: `tedix · codex waiting: ${body}?`,
					body,
					respondedAt: "2026-10-09T10:00:00.000Z",
					sessionId: SESSION,
					host: "codex",
					workItemId: null,
					projectId: PROJECT,
				});
				const { out, calls } = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "status?" },
					[],
					[
						{
							data: [
								answer(
									"88888888-8888-4888-8888-888888888888",
									"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
									"Retry",
								),
								answer(REQUEST, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Hold"),
							],
							observedAt: "2026-10-09T10:00:00.000Z",
						},
					],
				);
				expect(
					context(out)
						.split("\n")
						.filter(
							(line: string) => !line.startsWith("Tedix turn context checked"),
						)
						.join("\n"),
				).toBe(
					[
						"The user replied in Tedix OS to 2 of your questions. These are the user's own answers, not tedi drafts; act on each, oldest first:",
						'1. To "Retry?": "Retry"',
						'2. To "Hold?": "Hold"',
					].join("\n"),
				);
				const listed = calls.find((args) =>
					args.some((arg) =>
						arg.includes("list_undelivered_work_interaction_responses"),
					),
				)!;
				expect(listed.at(-1)).toContain(
					`(${JSON.stringify({ sessionId: SESSION, limit: 50 })})`,
				);
				const acked = calls.find((args) =>
					args.some((arg) => arg.includes("ack_work_interaction_delivery")),
				)!;
				expect(workToolCall(acked)?.input).toEqual({
					responseIds: [
						"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
						"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					],
					via: "prompt_context",
				});
				// The answered question is consumed; the interaction is never read by ID.
				expect(existsSync(join(dir, `${SESSION}.question.json`))).toBe(false);
				expect(
					calls.some((args) =>
						args.some((arg) => arg.includes("get_work_interaction")),
					),
				).toBe(false);
			}));

		test("an open question's tedi draft never reaches the session, even on ok", () =>
			withConfig(async (config, dir) => {
				for (const prompt of ["ok", "PRIVATE PROMPT"]) {
					const { out, calls, sources } = await run(
						[CAPTURE, LOGIN, NO_LESSONS],
						{ TEDIX_CONFIG_DIR: config },
						{ session_id: SESSION, prompt },
						[detail()],
					);
					expect(context(out).split("\n")).toHaveLength(1);
					expect(sources).toEqual([]);
					expect(
						calls.some(
							(args) =>
								workToolCall(args)?.name === "get_work_interaction" &&
								workToolCall(args)?.input.requestId === REQUEST,
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
				expect(
					context(out)
						.split("\n")
						.filter(
							(line: string) => !line.startsWith("Tedix turn context checked"),
						)
						.join("\n"),
				).toBe(
					`The user replied in Tedix OS to Interaction ${REQUEST}: "Hold the deploy."`,
				);
				expect(existsSync(join(dir, `${SESSION}.question.json`))).toBe(false);
				const again = await run(
					[CAPTURE, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "status?" },
					[answered],
				);
				expect(again.out).not.toContain("Hold the deploy");
				expect(again.out).not.toContain("Tedix context unchanged");
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
				expect(context(out).split("\n")).toHaveLength(1);
				// Context, auth, the missing answer ledger, question, shared sources and catalog.
				expect(calls).toHaveLength(6);
				({ out, calls } = await run(
					[{ ...CAPTURE, decisionCapture: false }, LOGIN, NO_LESSONS],
					{ TEDIX_CONFIG_DIR: config },
					{ session_id: SESSION, prompt: "ok" },
				));
				// Live lessons are checked even when the previous set was empty.
				expect([
					JSON.parse(out).hookSpecificOutput.additionalContext.split("\n")
						.length,
					calls.length,
				]).toEqual([1, 4]);
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
				expect([
					JSON.parse(out).hookSpecificOutput.additionalContext.split("\n")
						.length,
					calls.length,
				]).toEqual([1, 4]);
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
		expect(
			JSON.parse(
				(await run([DEFAULT, AUTH, NO_LESSONS])).out,
			).hookSpecificOutput.additionalContext.split("\n"),
		).toHaveLength(1);
		const { out, calls } = await run([{ status: "unbound" }]);
		expect(out).toBe("");
		expect(calls).toHaveLength(1);
	});

	test("never reads a task selection a default context could carry", async () => {
		const { calls } = await run([
			{
				...DEFAULT,
				osWorkspaceId: WORKSPACE,
				contextOutputId: OUTPUT,
				workItemId: WORK,
			},
			AUTH,
			NO_LESSONS,
		]);
		expect(calls[2]!.at(-1)).not.toContain(OUTPUT);
		expect(calls[2]!.at(-1)).not.toContain(WORK);
	});

	test("reads the organization's working preferences beside its lessons", async () => {
		const { out, calls } = await run([
			{
				...DEFAULT,
				preferencesWorkspaceId: WORKSPACE,
				preferencesOutputId: OUTPUT,
			},
			AUTH,
			{
				preferences: copy(DATA.shared),
				...lessonsData([{ shortId: "abcd1234", text: "Quote prices in EUR." }]),
			},
		]);
		expect(calls[2]!.at(-1)).toContain(OUTPUT);
		const text = additional(out);
		expect(text).toContain("Working preferences");
		expect(text).toContain("simple user stories");
		expect(text).toContain("Quote prices in EUR.");
		expect(text).toContain("For a status question, check live state");
	});
});

describe("prompt-context open delegations", () => {
	const LEAD = "77777777-7777-4777-8777-777777777777";
	const OTHER = "88888888-8888-4888-8888-888888888888";
	const OPEN = "aaaaaaaa-1111-4111-8111-111111111111";
	const DONE = "bbbbbbbb-2222-4222-8222-222222222222";
	const additional = (out: string): string =>
		out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
	const now = new Date("2026-10-09T12:00:00Z");
	const entry = (id: string, title: string): Delegation => ({
		id,
		title,
		via: "subagent",
		to: "docs-pass",
		workspace: "fixture",
		createdAt: "2026-10-09T10:00:00Z",
	});

	test("only the lead session sees its open delegations; settled ones drop off", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tedix-delegations-"));
		try {
			const env = { TEDIX_CONFIG_DIR: dir };
			recordDelegation(env, `claude-code:${LEAD}`, entry(DONE, "Old task"));
			recordDelegation(env, `claude-code:${LEAD}`, entry(OPEN, "Rewrite docs"));
			const data = {
				...NO_LESSONS,
				delegations: [
					{ id: OPEN, disposition: "accepted" },
					{ id: DONE, disposition: "completed" },
				],
			};
			const { contextOutputId: _o, osWorkspaceId: _w, ...binding } = BINDING;
			const lead = await run([binding, AUTH, data], env, {
				session_id: LEAD,
				prompt: "PRIVATE",
			});
			const text = additional(lead.out);
			expect(lead.calls[2]!.at(-1)).toContain(OPEN);
			expect(text).toContain("Your open delegations");
			expect(text).toMatch(
				/- aaaaaaaa · \S+ · via subagent → "docs-pass" · "Rewrite docs"/,
			);
			expect(text).not.toContain("Old task");
			expect(readDelegations(env, LEAD).map((d) => d.id)).toEqual([OPEN]);
			const other = await run([binding, AUTH, NO_LESSONS], env, {
				session_id: OTHER,
				prompt: "PRIVATE",
			});
			expect(JSON.stringify(other.calls)).not.toContain(OPEN);
			expect(additional(other.out)).not.toContain("open delegations");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("delegation lines go after the extra lessons, before the top six", () => {
		const tasks = Array.from({ length: 8 }, (_, i) =>
			entry(
				`cccccccc-${String(i).padStart(4, "0")}-4111-8111-111111111111`,
				`Task ${i}`,
			),
		);
		const data = {
			...lessonsData(
				Array.from({ length: 8 }, (_, i) => ({
					shortId: `l${i}`,
					text: "x".repeat(300),
				})),
			),
			delegations: tasks.map((t) => ({ id: t.id, disposition: "accepted" })),
		};
		const { contextOutputId: _o, osWorkspaceId: _w, ...binding } = BINDING;
		const full = render(binding, data, now, 100_000, tasks);
		expect(full.match(/^- cccccccc/gm)).toHaveLength(8);
		const size = Buffer.byteLength(full);
		const tight = render(binding, data, now, size - 200, tasks);
		expect(tight.match(/^- cccccccc/gm)).toHaveLength(8);
		expect(tight.match(/\[l\d\]/g)).toHaveLength(7);
		const tighter = render(binding, data, now, size - 1000, tasks);
		expect((tighter.match(/^- cccccccc/gm) ?? []).length).toBeLessThan(8);
		expect(tighter.match(/\[l\d\]/g)).toHaveLength(6);
		expect(
			gatewayCode(binding, undefined, [tasks[0]!.id, "not-a-uuid"]),
		).toContain(`"delegations":["${tasks[0]!.id}"]`);
	});
});

describe("prompt-context latency: parallel reads and the local cache", () => {
	const PREFERENCE_OUTPUT = "88888888-8888-4888-8888-888888888888";
	const SESSION = "99999999-9999-4999-8999-999999999999";
	const { contextOutputId: _o, osWorkspaceId: _w, ...withoutTask } = BINDING;
	const binding: JsonObject = {
		...withoutTask,
		workspace: "connect",
		org: "org_target",
		organization: "org_target",
		mcpUrl: "https://connect.mcp.tedix.dev/mcp",
		preferencesWorkspaceId: WORKSPACE,
		preferencesOutputId: PREFERENCE_OUTPUT,
		decisionCapture: true,
	};
	const auth: JsonObject = {
		wouldUse: "stored-login",
		workspace: "connect",
		mcpUrl: binding.mcpUrl,
		storedLogin: {
			org: "org_target",
			loginId: "U-me",
			accessToken: { selectedOrganizations: ["org_target"] },
		},
	};
	const preferences = (): JsonObject => {
		const document = copy(DATA.shared);
		document.output.id = PREFERENCE_OUTPUT;
		document.revision.outputId = PREFERENCE_OUTPUT;
		document.text = "Handle authorized routine choices.";
		return document;
	};
	const lesson = { shortId: "abcd1234", text: "Pushes race on main." };
	const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
	const additional = (lines: string[]): string =>
		lines.length
			? JSON.parse(lines.join("\n")).hookSpecificOutput.additionalContext
			: "";

	/** One hook run against a scripted gateway; `delay` slows every live read. */
	async function turn(options: {
		config: string;
		now: Date;
		delay?: number;
		question?: boolean;
		binding?: JsonObject;
		gateway?: (code: string) => JsonObject | Promise<JsonObject>;
		probe?: () => JsonObject;
		session?: string;
		contextBytes?: string;
	}): Promise<{ text: string; steps: string[]; timeouts: number[] }> {
		const steps: string[] = [];
		const timeouts: number[] = [];
		const lines: string[] = [];
		let catalogResponse: JsonObject | undefined;
		const env = {
			TEDIX_CONFIG_DIR: options.config,
			TEDIX_HOOK_CONTEXT_BYTES: options.contextBytes ?? "10000",
		};
		const stateDir = join(options.config, "decision-capture");
		mkdirSync(stateDir, { recursive: true });
		const question = join(stateDir, `${SESSION}.question.json`);
		if (options.question)
			writeFileSync(
				question,
				JSON.stringify({ requestId: WORK, token: "t", host: "claude-code" }),
			);
		else rmSync(question, { force: true });
		await runPromptContext({
			env,
			stdin: JSON.stringify({
				session_id: options.session ?? SESSION,
				prompt: "PRIVATE",
			}),
			cwd: process.cwd(),
			now: () => options.now,
			write: (line) => lines.push(line),
			read: async (args, timeout) => {
				if (args.some((arg) => arg.includes('"nextWork":')))
					return { nextWork: { data: [] } };
				timeouts.push(timeout);
				if (args[0] === "setup") return copy(options.binding ?? binding);
				if (args.includes("auth")) return copy(auth);
				await sleep(options.delay ?? 0);
				if (
					args.some((arg) =>
						arg.includes("list_undelivered_work_interaction_responses"),
					)
				) {
					steps.push("answers");
					return {
						data: [
							{
								responseId: WORK,
								requestId: WORK,
								subject: "repo · claude waiting: proceed?",
								body: "Yes, proceed.",
								respondedAt: "2026-10-11T09:00:00.000Z",
								sessionId: SESSION,
								host: null,
								workItemId: null,
								projectId: null,
							},
						],
						observedAt: "2026-10-11T09:00:01.000Z",
					};
				}
				if (args.some((arg) => arg.includes("ack_work_interaction_delivery")))
					return { data: [] };
				const code = String(args.at(-1));
				if (code.includes("codemode.__runtime")) {
					steps.push("organization");
					return (options.probe ?? (() => ({ organizationId: ORG })))();
				}
				if (code.includes('"selectedLessonIds"')) {
					steps.push("validation");
					return {
						lessons: catalogResponse?.lessons ?? lessonsData([lesson]).lessons,
					};
				}
				const isCatalog = code.includes('"catalog":true');
				steps.push(isCatalog ? "catalog" : "gateway");
				const response = await (
					options.gateway ??
					(() => ({ preferences: preferences(), ...lessonsData([lesson]) }))
				)(code);
				if (isCatalog) catalogResponse = response;
				return copy(response);
			},
		});
		return { text: additional(lines), steps, timeouts };
	}

	test("the organization probe, the answer reads and the gateway read run together", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-prompt-parallel-"));
		const started = Date.now();
		const { text, steps } = await turn({
			config,
			now: new Date(),
			delay: 150,
			question: true,
		});
		const elapsed = Date.now() - started;
		expect(steps.sort()).toEqual([
			"answers",
			"catalog",
			"gateway",
			"organization",
			"validation",
		]);
		// Three 150ms reads in sequence would take 450ms; together, about one.
		expect(elapsed).toBeLessThan(600);
		expect(text).toContain("Handle authorized routine choices");
		expect(text).toContain("Pushes race on main");
		expect(text).toContain("The user replied in Tedix OS");
		rmSync(config, { recursive: true, force: true });
	});

	test("session receipts suppress unchanged content and detect live revisions and lessons", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-context-delivery-"));
		const now = new Date("2026-10-11T09:00:00Z");
		try {
			const first = await turn({ config, now });
			expect(first.text).toContain("Handle authorized routine choices");
			expect(first.text).toContain("Pushes race on main");
			const second = await turn({ config, now });
			expect(second.steps).toEqual(["gateway", "catalog", "validation"]);
			expect(second.text).not.toContain("unchanged");
			expect(second.text).not.toContain("Handle authorized routine choices");
			expect(second.text).not.toContain("Pushes race on main");
			expect(second.text.split("\n")).toHaveLength(1);
			const changed = preferences();
			changed.revision.revision = 3;
			const revision = await turn({
				config,
				now,
				gateway: () => ({ preferences: changed, ...lessonsData([lesson]) }),
			});
			expect(revision.text).toContain("revision=3;");
			expect(revision.text).toContain("Handle authorized routine choices");
			expect(revision.text).not.toContain("Pushes race on main");
			const newLesson = { ...lesson, text: "Verify the pushed commit." };
			const lessons = await turn({
				config,
				now,
				gateway: () => ({ preferences: changed, ...lessonsData([newLesson]) }),
			});
			expect(lessons.text).toContain(newLesson.text);
			expect(lessons.text).not.toContain("Handle authorized routine choices");
			const state = readdirSync(join(config, "hook-cache")).find((name) =>
				name.startsWith("delivery-"),
			)!;
			const receipt = readFileSync(join(config, "hook-cache", state), "utf8");
			expect(receipt.length).toBeLessThan(300);
			expect(receipt).not.toContain("PRIVATE");
			expect(receipt).not.toContain("Handle authorized");
			writeFileSync(join(config, "hook-cache", state), "broken JSON");
			const recovered = await turn({ config, now });
			expect(recovered.text).toContain("Handle authorized routine choices");
			expect(recovered.text).toContain("Pushes race on main");
			const otherSession = await turn({ config, now, session: WORK });
			expect(otherSession.text).toContain("Handle authorized routine choices");
			const otherScope = await turn({
				config,
				now,
				binding: { ...binding, projectId: WORK },
			});
			expect(otherScope.text).not.toContain("Tedix context unchanged");
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("trimmed first-turn sources are not marked delivered and fit in the expanded hook", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-delivery-trim-"));
		const now = new Date();
		const document = { ...preferences(), text: "p".repeat(3040) };
		const fullLessons = lessonsData(
			Array.from({ length: 7 }, (_, i) => ({
				shortId: `lesson${i}`,
				text: "l".repeat(440),
			})),
		);
		const gateway = () => ({ preferences: document, ...fullLessons });
		try {
			const trimmed = await turn({
				config,
				now,
				gateway,
				contextBytes: "6400",
			});
			expect(trimmed.text).toContain("complete=false");
			expect(Buffer.byteLength(trimmed.text)).toBeLessThanOrEqual(6400);
			const next = await turn({ config, now, gateway });
			expect(next.text).toContain(document.text);
			expect(next.text).toContain("complete=true");
			const unchanged = await turn({ config, now, gateway });
			expect(unchanged.text).not.toContain("Tedix context unchanged");
			expect(unchanged.text).not.toContain(document.text);
			rmSync(join(config, "hook-cache"), { recursive: true, force: true });
			const expanded = await turn({ config, now, gateway });
			expect(expanded.text).toContain(document.text);
			expect(expanded.text).toContain("Team lessons: 6 of 7 approved");
			expect(expanded.text).not.toContain("complete=false");
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("a cold lessons failure retries once with a short backoff and preserves preferences", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-lessons-retry-"));
		const now = new Date();
		let attempts = 0;
		const started = Date.now();
		try {
			const recovered = await turn({
				config,
				now,
				gateway: (code) => {
					if (!code.includes('"catalog":true'))
						return { preferences: preferences() };
					attempts++;
					if (attempts === 1)
						return {
							preferences: preferences(),
							lessons: { unavailable: true },
						};
					expect(code).not.toContain(PREFERENCE_OUTPUT);
					return lessonsData([lesson]);
				},
			});
			expect(attempts).toBe(2);
			expect(Date.now() - started).toBeGreaterThanOrEqual(140);
			expect(recovered.timeouts.at(-1)).toBe(9000);
			expect(recovered.text).toContain("Handle authorized routine choices");
			expect(recovered.text).toContain(lesson.text);
			expect(recovered.text).not.toContain("lessons unavailable");
			expect((await turn({ config, now })).text).not.toContain(
				"Tedix context unchanged",
			);
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("persistent lessons failures stop after two reads and recover on a later turn", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-lessons-failed-"));
		const now = new Date();
		let attempts = 0;
		try {
			const failed = await turn({
				config,
				now,
				gateway: (code) => {
					if (!code.includes('"catalog":true'))
						return { preferences: preferences() };
					attempts++;
					return { preferences: preferences(), lessons: { unavailable: true } };
				},
			});
			expect(attempts).toBe(2);
			expect(failed.text).not.toContain("Team lessons unavailable");
			expect(failed.text).toContain("Handle authorized routine choices");
			const recovered = await turn({ config, now });
			expect(recovered.text).toContain(lesson.text);
			expect(recovered.text).not.toContain("Handle authorized routine choices");
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("a slow shared-source read does not suppress independently validated lessons", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-independent-lessons-"));
		try {
			const result = await turn({
				config,
				now: new Date(),
				gateway: (code) => {
					if (code.includes('"catalog":true')) return lessonsData([lesson]);
					throw new Error("Tedix CLI read deadline elapsed");
				},
			});
			expect(result.text).toContain(lesson.text);
			expect(result.text).not.toContain("Handle authorized routine choices");
			expect(result.steps).toContain("validation");
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("a dead gateway omits preferences and lessons at every cache age", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-prompt-failsoft-"));
		const start = new Date("2026-10-11T09:00:00Z");
		const timedOut = () => {
			throw new Error("Tedix CLI read deadline elapsed");
		};
		// First deliver content so a failed later read cannot replay it.
		const seeded = await turn({ config, now: start });
		expect(seeded.text).toContain("Handle authorized routine choices");
		// A timed-out gateway never replays a previous source.
		const dead = await turn({
			config,
			now: new Date(start.getTime() + 20 * 60_000),
			gateway: timedOut,
		});
		expect(dead.text).not.toContain("Tedix context unchanged");
		expect(
			dead.steps.filter((step) => ["gateway", "catalog"].includes(step)).sort(),
		).toEqual(["catalog", "gateway"]);
		expect(dead.text).not.toContain("Tedix shared context unavailable");
		expect(dead.text).not.toContain("Handle authorized routine choices");
		expect(dead.text).not.toContain(lesson.text);
		expect(dead.text).not.toContain("cached");
		// Selected Work still reports an unavailable live read.
		const partial = await turn({
			config,
			now: new Date(start.getTime() + 21 * 60_000),
			binding: {
				...binding,
				workItemId: WORK,
				osWorkspaceId: WORKSPACE,
				contextOutputId: OUTPUT,
			},
			gateway: timedOut,
		});
		expect(partial.text).not.toContain("Tedix context unchanged");
		expect(partial.text).toContain(`Selected Work=${WORK} unavailable`);
		expect(partial.text).not.toContain("Shared decisions unavailable");
		// Old content also stays omitted after an hour.
		const expired = await turn({
			config,
			now: new Date(start.getTime() + 90 * 60_000),
			gateway: timedOut,
		});
		expect(expired.text).not.toContain("Tedix shared context unavailable");
		// A failed organization probe (its own copy past the TTL) still hides everything: a fence, not a source.
		const unverified = await turn({
			config,
			now: new Date(start.getTime() + 105 * 60_000),
			probe: timedOut,
		});
		expect(unverified.text).toContain("Tedix shared context unavailable");
		rmSync(config, { recursive: true, force: true });
	});

	test("an unchanged upstream-truncated preference is not replayed every turn", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-partial-preference-"));
		try {
			const gateway = () => ({
				preferences: { ...preferences(), complete: false },
				...lessonsData([lesson]),
			});
			const first = await turn({ config, now: new Date(), gateway });
			expect(first.text).toContain("complete=false");
			expect(first.text).toContain("Handle authorized routine choices");
			const next = await turn({ config, now: new Date(), gateway });
			expect(next.text).not.toContain("Handle authorized routine choices");
			expect(next.text).not.toContain("unchanged");
			expect(next.text.split("\n").length).toBeLessThanOrEqual(8);
		} finally {
			rmSync(config, { recursive: true, force: true });
		}
	});

	test("per-turn reads keep tight timeouts", async () => {
		const config = mkdtempSync(join(tmpdir(), "tedix-prompt-timeouts-"));
		const { timeouts } = await turn({
			config,
			now: new Date(),
			question: true,
		});
		// Validation can use remaining host time, capped at 9s; other reads stay bounded.
		expect(Math.max(...timeouts)).toBeLessThanOrEqual(9000);
		expect(timeouts).toContain(3000);
		expect(timeouts).toContain(9000);
		rmSync(config, { recursive: true, force: true });
	});
});

test("reranks a shared scope catalog per prompt without caching or sending the prompt", async () => {
	const config = mkdtempSync(join(tmpdir(), "tedix-local-ranking-"));
	const { osWorkspaceId: _w, contextOutputId: _o, ...binding } = BINDING;
	const catalog = lessonsData([
		{
			shortId: "deploy00",
			text: "Verify deployment health and release revision.",
		},
		{
			shortId: "database",
			text: "Use database batches with D1 queries and bound parameters.",
		},
	]);
	try {
		const first = await run(
			[binding, AUTH, catalog],
			{ TEDIX_CONFIG_DIR: config },
			{ prompt: "PRIVATE_ALPHA database D1 query bound parameters" },
		);
		const second = await run(
			[binding, AUTH, catalog],
			{ TEDIX_CONFIG_DIR: config },
			{ prompt: "PRIVATE_BETA deployment health release revision" },
		);
		expect(first.out.indexOf("[database]")).toBeLessThan(
			first.out.indexOf("[deploy00]"),
		);
		expect(second.out.indexOf("[deploy00]")).toBeLessThan(
			second.out.indexOf("[database]"),
		);
		expect(
			second.calls.filter((c) =>
				c.some((a) => a.includes("agent.get_agent_session_lessons")),
			),
		).toHaveLength(2);
		expect(JSON.stringify([...first.calls, ...second.calls])).not.toMatch(
			/PRIVATE_ALPHA|PRIVATE_BETA/,
		);
		for (const file of existsSync(join(config, "hook-cache"))
			? readdirSync(join(config, "hook-cache"))
			: [])
			expect(
				readFileSync(join(config, "hook-cache", file), "utf8"),
			).not.toMatch(/PRIVATE_ALPHA|PRIVATE_BETA/);
	} finally {
		rmSync(config, { recursive: true, force: true });
	}
});
