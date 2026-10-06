import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { QueryClient } from "@tanstack/react-query";
import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { describe, expect, it } from "vite-plus/test";
import {
	activeOutputLibraryQueryOptions,
	commandPaletteOutputLibraryQueryOptions,
	canvasGadgetsQueryOptions,
	canvasOutputsQueryOptions,
	homeMessagesQueryKey,
	homeMessagesQueryOptions,
	homeRunSetQueryKey,
	homeRunSetQueryOptions,
	outputDetailQueryOptions,
	pendingApprovalsQueryOptions,
	skillRunHistoryQueryOptions,
	workflowRunInspectQueryOptions,
} from "@/lib/os-query-options";
import {
	patchQueryCachesFromEvent,
	REALTIME_PATCHED_EVENT_KINDS,
} from "./realtime-projections";

const CONVERSATION_ID = "home:main";
const OTHER_CONVERSATION_ID = "home:other";
const ORG_ID = "org-1";
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UNSEEN_RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const APPROVAL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WORKSPACE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OUTPUT_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function event(overrides: Partial<RuntimeStreamEvent>): RuntimeStreamEvent {
	return {
		id: overrides.id ?? "evt-1",
		kind: overrides.kind ?? "run.started",
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		createdAt: "2026-08-16T10:00:00.000Z",
		...overrides,
	};
}

function client() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
}

function seedRunSet(
	queryClient: QueryClient,
	status: TediRunStatus = "running",
) {
	queryClient.setQueryData(homeRunSetQueryKey(CONVERSATION_ID), {
		runSet: {
			organizationId: ORG_ID,
			conversationId: CONVERSATION_ID,
			activeRunIds: [RUN_ID],
			runs: [
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: CONVERSATION_ID,
					status,
					createdAt: "2026-08-16T09:59:00.000Z",
				},
				{
					id: OTHER_RUN_ID,
					organizationId: ORG_ID,
					conversationId: CONVERSATION_ID,
					status: "completed",
					createdAt: "2026-08-16T09:00:00.000Z",
				},
			],
		},
	});
}

function readRunSet(queryClient: QueryClient) {
	return queryClient.getQueryData<{
		runSet: {
			activeRunIds: string[];
			runs: Array<{ id: string; status: string; completedAt?: string | null }>;
		};
	}>(homeRunSetQueryKey(CONVERSATION_ID));
}

// ---------------------------------------------------------------------------
// Cache patching
// ---------------------------------------------------------------------------

describe("patchQueryCachesFromEvent", () => {
	it("patches the run set in place and re-derives activeRunIds", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.completed" }),
			CONVERSATION_ID,
		);
		expect(outcome).toEqual({ patched: ["os-home-run-set"], invalidated: [] });
		const data = readRunSet(queryClient);
		expect(data?.runSet.runs.find((run) => run.id === RUN_ID)?.status).toBe(
			"completed",
		);
		// A pure derivation of the run statuses — it cannot drift from the server.
		expect(data?.runSet.activeRunIds).toEqual([]);
		// Untouched siblings stay untouched.
		expect(
			data?.runSet.runs.find((run) => run.id === OTHER_RUN_ID)?.status,
		).toBe("completed");
	});

	it("is idempotent: a replayed terminal event patches nothing twice", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.failed" }),
			CONVERSATION_ID,
		);
		const first = readRunSet(queryClient);
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.failed" }),
			CONVERSATION_ID,
		);
		expect(outcome).toEqual({ patched: [], invalidated: [] });
		expect(readRunSet(queryClient)).toBe(first);
	});

	it("falls back to a refetch for a run the cache has never seen", () => {
		const queryClient = client();
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.started" }),
			CONVERSATION_ID,
		);
		// The row carries an input message id, runtime ref and timestamps the
		// event does not: synthesizing it would render a claim no read supports.
		expect(outcome).toEqual({ patched: [], invalidated: ["os-home-run-set"] });
	});

	it("appends the assistant turn from message.completed using cached identity", () => {
		const queryClient = client();
		queryClient.setQueryData(homeMessagesQueryKey(CONVERSATION_ID), {
			messages: [
				{
					id: "msg-user",
					organizationId: ORG_ID,
					conversationId: CONVERSATION_ID,
					role: "user",
					status: "completed",
					content: "hello",
					createdAt: "2026-08-16T09:59:00.000Z",
				},
			],
			nextCursor: null,
		});
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({
				kind: "message.completed",
				messageId: "msg-assistant",
				payload: { role: "assistant", content: "the answer" },
			}),
			CONVERSATION_ID,
		);
		expect(outcome.patched).toEqual(["os-home-messages"]);
		const data = queryClient.getQueryData<{
			messages: Array<{ id: string; content: string; organizationId: string }>;
		}>(homeMessagesQueryKey(CONVERSATION_ID));
		expect(data?.messages).toHaveLength(2);
		const appended = data?.messages[1];
		expect(appended?.id).toBe("msg-assistant");
		expect(appended?.content).toBe("the answer");
		// Identity is READ off the cached page, never invented.
		expect(appended?.organizationId).toBe(ORG_ID);
	});

	it("refetches the transcript when message.completed carries no answer", () => {
		const queryClient = client();
		queryClient.setQueryData(homeMessagesQueryKey(CONVERSATION_ID), {
			messages: [
				{
					id: "msg-user",
					organizationId: ORG_ID,
					conversationId: CONVERSATION_ID,
					role: "user",
					status: "completed",
					content: "hello",
					createdAt: "2026-08-16T09:59:00.000Z",
				},
			],
		});
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "message.completed", messageId: "msg-assistant" }),
			CONVERSATION_ID,
		);
		expect(outcome).toEqual({ patched: [], invalidated: ["os-home-messages"] });
	});

	it("removes a resolved approval from the pending list without a refetch", () => {
		const queryClient = client();
		// Contract-derived keys are TYPED (the literal this replaced was not), so
		// the fixture is narrowed to the fields the assertion reads rather than
		// restating an approval row the contract already owns.
		queryClient.setQueryData(pendingApprovalsQueryOptions().queryKey, {
			data: [
				{ id: APPROVAL_ID, status: "pending" },
				{ id: "other", status: "pending" },
			],
		} as never);
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({
				kind: "approval.resolved",
				payload: { approvalRequestId: APPROVAL_ID },
			}),
			CONVERSATION_ID,
		);
		expect(outcome.patched).toContain("os-approvals/pending");
		const data = queryClient.getQueryData<{ data: Array<{ id: string }> }>(
			pendingApprovalsQueryOptions().queryKey,
		);
		expect(data?.data.map((row) => row.id)).toEqual(["other"]);
	});

	it("refetches pending approvals on approval.requested (an insert is not on the wire)", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({
				kind: "approval.requested",
				payload: { approvalRequestId: APPROVAL_ID },
			}),
			CONVERSATION_ID,
		);
		expect(outcome.invalidated).toContain("os-approvals/pending");
		// The run set is INVALIDATED, not patched. Approval cards render from
		// runSet.approvalMirrors, which this event cannot reconstruct — patching
		// the status alone would show "requires approval" with no approve or
		// reject affordance anywhere on the page.
		expect(outcome.invalidated).toContain("os-home-run-set");
		expect(outcome.patched).toEqual([]);
	});

	it("leaves skill-workflow run keys alone (a different id space)", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		// Seeded through the GENERATED factories on purpose: skill runs and a
		// run's inspect read left the hand-written `["os-skill-runs"]` /
		// `["os-run", runId, …]` namespace, so asserting against those literals
		// would assert about a cache nothing writes any more.
		const skillRuns = skillRunHistoryQueryOptions(25).queryKey;
		const inspect = workflowRunInspectQueryOptions(RUN_ID).queryKey;
		queryClient.setQueryData(skillRuns, { runs: [{ id: RUN_ID }] } as never);
		queryClient.setQueryData(inspect, {
			run: { id: RUN_ID, status: "running" },
		} as never);
		patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.completed" }),
			CONVERSATION_ID,
		);
		// Kernel Home run ids are NOT skill-workflow run ids; patching one from
		// the other looks right in a test and is wrong in production.
		expect(
			queryClient.getQueryData<{ run: { status: string } }>(inspect)?.run
				.status,
		).toBe("running");
		expect(queryClient.getQueryState(inspect)?.isInvalidated).toBe(false);
		expect(queryClient.getQueryState(skillRuns)?.isInvalidated).toBe(false);
	});

	it("reacts to nothing outside its declared kind set", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		for (const kind of ["message.delta", "tool.started", "step.completed"]) {
			expect(REALTIME_PATCHED_EVENT_KINDS.has(kind)).toBe(false);
			expect(
				patchQueryCachesFromEvent(
					queryClient,
					event({ kind }),
					CONVERSATION_ID,
				),
			).toEqual({
				patched: [],
				invalidated: [],
			});
		}
	});
});

// ---------------------------------------------------------------------------
// Namespace coherence
//
// apps/os keys server reads two ways — generated oRPC keys from `osQuery` /
// `osQueryKeys`, and hand-written literals — and React Query matching is
// PREFIX-based, so the two namespaces cannot reach each other. A domain whose
// component read moved to a generated key while this module still writes the
// literal (or the reverse) renders stale forever with no error, no retry and no
// refetch. These tests turn that into a red test instead of a support ticket.
// ---------------------------------------------------------------------------

describe("realtime invalidation reaches the entries components cache", () => {
	// The palette's own limit; any limit works here, which is the point — every
	// input variant sits under the one generated outputs prefix.
	const PALETTE_LIMIT = 12;

	it("artifact.created reaches every generated outputs entry, open document included", () => {
		const queryClient = client();
		const canvasList = canvasOutputsQueryOptions(WORKSPACE_ID).queryKey;
		const library = activeOutputLibraryQueryOptions().queryKey;
		const paletteSlice =
			commandPaletteOutputLibraryQueryOptions(PALETTE_LIMIT).queryKey;
		const openDocument = outputDetailQueryOptions(OUTPUT_ID).queryKey;
		const gadgetList = canvasGadgetsQueryOptions(WORKSPACE_ID).queryKey;
		for (const key of [
			canvasList,
			library,
			paletteSlice,
			openDocument,
			gadgetList,
		]) {
			// Only the presence of an entry matters; the payload shape is the
			// contract's business. (`undefined` would store nothing at all.)
			queryClient.setQueryData(key, { items: [] } as never);
		}

		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "artifact.created", id: "evt-artifact" }),
			CONVERSATION_ID,
		);

		expect(outcome).toEqual({ patched: [], invalidated: ["os-outputs"] });
		// The list and the open document were both once hand-written literals that this prefix could never reach.
		for (const key of [canvasList, library, paletteSlice, openDocument]) {
			expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
		}
		// The other half of a prefix invalidation: it must stay narrow. Gadget
		// documents are a sibling domain and are not what an artifact changed.
		expect(queryClient.getQueryState(gadgetList)?.isInvalidated).toBe(false);
	});

	it("message.received invalidates the transcript entry the thread reads, and only that conversation's", () => {
		const queryClient = client();
		queryClient.setQueryData(homeMessagesQueryKey(CONVERSATION_ID), {
			messages: [],
		});
		queryClient.setQueryData(homeMessagesQueryKey(OTHER_CONVERSATION_ID), {
			messages: [],
		});

		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "message.received", id: "evt-user" }),
			CONVERSATION_ID,
		);

		expect(outcome).toEqual({ patched: [], invalidated: ["os-home-messages"] });
		expect(
			queryClient.getQueryState(homeMessagesQueryKey(CONVERSATION_ID))
				?.isInvalidated,
		).toBe(true);
		// The key carries the conversation id, so a second open thread is not
		// dragged into a refetch by someone else's turn.
		expect(
			queryClient.getQueryState(homeMessagesQueryKey(OTHER_CONVERSATION_ID))
				?.isInvalidated,
		).toBe(false);
	});

	it("approval.requested invalidates BOTH the pending list and the run set entry", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		queryClient.setQueryData(pendingApprovalsQueryOptions().queryKey, {
			data: [],
		} as never);

		patchQueryCachesFromEvent(
			queryClient,
			event({
				kind: "approval.requested",
				id: "evt-approval",
				payload: { approvalRequestId: APPROVAL_ID },
			}),
			CONVERSATION_ID,
		);

		expect(
			queryClient.getQueryState(pendingApprovalsQueryOptions().queryKey)
				?.isInvalidated,
		).toBe(true);
		// The approve/reject affordance renders from runSet.approvalMirrors, so
		// the run set entry has to be reached too or the card appears with no
		// buttons.
		expect(
			queryClient.getQueryState(homeRunSetQueryKey(CONVERSATION_ID))
				?.isInvalidated,
		).toBe(true);
	});

	it("approval.resolved without an id on the wire falls back to reaching the pending list", () => {
		const queryClient = client();
		queryClient.setQueryData(pendingApprovalsQueryOptions().queryKey, {
			data: [{ id: APPROVAL_ID, status: "pending" }],
		} as never);

		const outcome = patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "approval.resolved", id: "evt-resolved", payload: {} }),
			CONVERSATION_ID,
		);

		expect(outcome.patched).toEqual([]);
		expect(outcome.invalidated).toContain("os-approvals/pending");
		expect(
			queryClient.getQueryState(pendingApprovalsQueryOptions().queryKey)
				?.isInvalidated,
		).toBe(true);
	});

	it("a run the cache has never seen invalidates the run set entry the thread reads", () => {
		const queryClient = client();
		seedRunSet(queryClient);

		patchQueryCachesFromEvent(
			queryClient,
			// Started in another tab or by the CLI: the row cannot be synthesized.
			event({ kind: "run.started", id: "evt-elsewhere", runId: UNSEEN_RUN_ID }),
			CONVERSATION_ID,
		);

		expect(
			queryClient.getQueryState(homeRunSetQueryKey(CONVERSATION_ID))
				?.isInvalidated,
		).toBe(true);
	});

	it("reaches every generated realtime domain by the reader's exact key", () => {
		const queryClient = client();
		seedRunSet(queryClient);
		queryClient.setQueryData(homeMessagesQueryKey(CONVERSATION_ID), {
			messages: [],
		});
		queryClient.setQueryData(pendingApprovalsQueryOptions().queryKey, {
			data: [],
		} as never);

		patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "run.completed" }),
			CONVERSATION_ID,
		);
		patchQueryCachesFromEvent(
			queryClient,
			event({ kind: "message.received", id: "evt-2" }),
			CONVERSATION_ID,
		);
		patchQueryCachesFromEvent(
			queryClient,
			event({
				kind: "approval.requested",
				id: "evt-3",
				payload: { approvalRequestId: APPROVAL_ID },
			}),
			CONVERSATION_ID,
		);

		expect(
			queryClient.getQueryState(homeMessagesQueryKey(CONVERSATION_ID))
				?.isInvalidated,
		).toBe(true);
		expect(readRunSet(queryClient)?.runSet.runs[0]?.status).toBe("completed");
		expect(
			queryClient.getQueryState(pendingApprovalsQueryOptions().queryKey)
				?.isInvalidated,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The source scan: a domain is either fully generated or fully hand-written
// ---------------------------------------------------------------------------

const SRC = resolve(process.cwd(), "src");

/** Every product source file, minus tests, generated output, and the factory module. */
function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const filePath = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(filePath);
		if (![".ts", ".tsx"].includes(extname(filePath))) return [];
		if (filePath.includes(".test.")) return [];
		if (filePath.endsWith("routeTree.gen.ts")) return [];
		// os-query-options.ts DEFINES every generated key; counting it as a
		// caller would make every domain look generated.
		if (filePath.endsWith(join("lib", "os-query-options.ts"))) return [];
		return [filePath];
	});
}

/**
 * Whole-line comments removed. Both namespaces are named in prose all over this
 * codebase — including the docblock of the module under test, which has to name
 * the generated factories it deliberately does not call — and prose is not a
 * cache read.
 */
function codeOf(source: string): string {
	return source
		.split("\n")
		.filter((line) => {
			const trimmed = line.trimStart();
			return !(
				trimmed.startsWith("//") ||
				trimmed.startsWith("*") ||
				trimmed.startsWith("/*")
			);
		})
		.join("\n");
}

/**
 * The four domains `patchQueryCachesFromEvent` writes. Deliberately not every
 * domain in the app: this guard covers what realtime touches, because that is
 * where a namespace split is invisible rather than merely wrong.
 */
const REALTIME_DOMAINS = [
	{
		domain: "Home run set (run.*, approval.*)",
		legacyHeads: ["os-home-run-set"],
		generated: [
			"homeRunSetQueryKey",
			"homeRunSetQueryOptions",
			"osQueryKeys.homeRunSet",
		],
	},
	{
		domain: "Home transcript (message.*)",
		legacyHeads: ["os-home-messages"],
		generated: [
			"homeMessagesQueryKey",
			"homeMessagesQueryOptions",
			"osQueryKeys.homeMessages",
		],
	},
	{
		domain: "Pending approvals (approval.*)",
		legacyHeads: ["os-approvals"],
		generated: ["pendingApprovalsQueryOptions", "osQueryKeys.approvals"],
	},
	{
		domain: "Canvas outputs (artifact.created)",
		legacyHeads: ["os-outputs", "os-output"],
		generated: [
			"osQueryKeys.outputs",
			"outputDetailQueryOptions",
			"canvasOutputsQueryOptions",
			"activeOutputLibraryQueryOptions",
			"commandPaletteOutputLibraryQueryOptions",
		],
	},
] as const;

/**
 * A hand-written key is an array literal whose head is the namespace string.
 * Anchoring on `["` is what keeps `outcome.invalidated.push("os-outputs")` — a
 * human-readable label, not a key — out of the result.
 */
function usesLegacyKey(code: string, heads: readonly string[]): boolean {
	return heads.some((head) => new RegExp(`\\[\\s*"${head}"`).test(code));
}

function usesGeneratedKey(code: string, tokens: readonly string[]): boolean {
	return tokens.some((token) =>
		new RegExp(`\\b${token.replace(/\./g, "\\.")}\\b`).test(code),
	);
}

describe("one key namespace per realtime domain", () => {
	const files = sourceFiles(SRC).map((filePath) => ({
		path: relative(SRC, filePath).split("\\").join("/"),
		code: codeOf(readFileSync(filePath, "utf8")),
	}));

	it("scans the source tree it claims to scan", () => {
		// Guards the guard: a moved file or a broken walk would otherwise make
		// every assertion below pass over an empty set.
		expect(files.length).toBeGreaterThan(50);
		expect(files.map((file) => file.path)).toContain(
			"lib/realtime-projections.ts",
		);
	});

	for (const { domain, legacyHeads, generated } of REALTIME_DOMAINS) {
		it(`keeps ${domain} in exactly one namespace`, () => {
			const legacyFiles = files
				.filter((file) => usesLegacyKey(file.code, legacyHeads))
				.map((file) => file.path);
			const generatedFiles = files
				.filter((file) => usesGeneratedKey(file.code, generated))
				.map((file) => file.path);
			const participants = [...legacyFiles, ...generatedFiles];

			// Vacuity guard: if a rename made both patterns miss, the split check
			// would pass while proving nothing.
			expect(participants.length).toBeGreaterThan(0);
			// And realtime must be one of the participants, or this module has
			// stopped writing a domain it is supposed to keep live.
			expect(participants).toContain("lib/realtime-projections.ts");

			const verdict =
				legacyFiles.length > 0 && generatedFiles.length > 0
					? `${domain} is SPLIT across both key namespaces. Hand-written: ${legacyFiles.join(
							", ",
						)} | generated: ${generatedFiles.join(
							", ",
						)}. Prefix matching cannot cross between them, so whichever half realtime does not write renders stale forever. Move every listed file in ONE commit, or move none.`
					: `${domain}: one namespace`;
			expect(verdict).toBe(`${domain}: one namespace`);
		});
	}
});
