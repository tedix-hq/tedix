import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { InteractionEventError } from "./interaction-events";
import { pollEvent } from "./work-events";

const ORG_A = "10000000-0000-4000-8000-00000000000a";
const ORG_B = "10000000-0000-4000-8000-00000000000b";
const ITEM = "20000000-0000-4000-8000-000000000001";
const env = {} as CloudflareEnv;
const caller = {
	authorization: "Bearer synthetic-only",
	mcpUrl: "https://plugin.example/mcp",
};

/** A fake API whose ledger rows belong to one organization each. */
function fakeApi(selectedOrg: string) {
	const ledger = [
		{ org: ORG_A, sequence: 3, id: "e3", change: "accepted" },
		{ org: ORG_B, sequence: 4, id: "e4", change: "accepted" },
		{ org: ORG_A, sequence: 5, id: "e5", change: "completed" },
	];
	const pollWorkStateChanges = vi.fn(
		async (input: { afterSequence: number | null; limit: number }) => {
			const own = ledger.filter((row) => row.org === selectedOrg);
			if (input.afterSequence == null)
				return {
					events: [],
					afterSequence: own.at(-1)?.sequence ?? 0,
					hasMore: false,
				};
			const after = own.filter((row) => row.sequence > input.afterSequence!);
			const page = after.slice(0, input.limit);
			return {
				events: page.map((row) => ({
					eventId: `evt_work_${row.id}`,
					timestamp: "2026-10-15T12:00:00.000Z",
					data: {
						organization_id: row.org,
						work_item_id: ITEM,
						change: row.change,
						disposition: row.change,
						attempt_id: null,
						attempt_outcome: null,
					},
				})),
				afterSequence: page.at(-1)?.sequence ?? input.afterSequence,
				hasMore: after.length > page.length,
			};
		},
	);
	const pollWorkApprovalRequests = vi.fn(async () => ({
		events: [],
		after: { at: "2026-10-15T12:00:00.000Z", id: "p1" },
		hasMore: false,
	}));
	const pollFailedSkillRuns = vi.fn(async () => ({
		events: [],
		after: { at: "", id: "" },
		hasMore: false,
	}));
	return {
		mcpEvents: {
			pollWorkStateChanges,
			pollWorkApprovalRequests,
			pollFailedSkillRuns,
		},
	};
}

let authorize: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof fakeApi>;
beforeEach(() => {
	authorize = vi.fn(
		async (
			_env: CloudflareEnv,
			credential: { organizationId: string },
			_scopes: readonly string[],
		) => {
			api = fakeApi(credential.organizationId);
			return {
				client: api,
				organizationId: credential.organizationId,
				owner: "human",
				expiresAt: Date.now() + 60_000,
			};
		},
	);
});

function poll(params: Record<string, unknown>) {
	return pollEvent(env, caller, params, {
		authorize: authorize as never,
	});
}

describe("events/poll over the Work ledger", () => {
	it("starts from now, then resumes after the returned cursor", async () => {
		const first = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: null,
		});
		expect(first).toMatchObject({
			events: [],
			cursor: "wsc1.5",
			truncated: false,
			hasMore: false,
			nextPollMs: 30_000,
		});

		const replay = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: "wsc1.0",
			maxEvents: 1,
		});
		expect(replay.events).toEqual([
			expect.objectContaining({
				eventId: "evt_work_e3",
				name: "work.item.state_changed",
			}),
		]);
		expect(replay).toMatchObject({ cursor: "wsc1.3", hasMore: true });

		const next = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: replay.cursor,
		});
		expect(next.events.map((event) => event.eventId)).toEqual(["evt_work_e5"]);
		expect(next).toMatchObject({ cursor: "wsc1.5", hasMore: false });
	});

	it("binds every poll to the organization named in the arguments", async () => {
		const result = await poll({
			name: "work.item.state_changed",
			arguments: { organization_id: ORG_A },
			cursor: "wsc1.0",
		});
		expect(
			result.events.every((event) => event.data.organization_id === ORG_A),
		).toBe(true);
		expect(authorize).toHaveBeenCalledWith(
			env,
			{ ...caller, organizationId: ORG_A },
			["mcp:work.read", "mcp:work.write", "mcp:work.admin"],
		);
	});

	it("rejects a caller whose grant does not select the requested organization", async () => {
		authorize.mockImplementationOnce(async () => {
			throw new Error("Organization not selected");
		});
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_B },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32024 });
		authorize.mockImplementationOnce(async () => ({
			client: fakeApi(ORG_A),
			organizationId: ORG_A,
			owner: "human",
			expiresAt: Date.now() + 60_000,
		}));
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_B },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32024 });
	});

	it("requires a skills scope for skill.run.failed", async () => {
		await poll({
			name: "skill.run.failed",
			arguments: { organization_id: ORG_A },
			cursor: null,
		});
		expect(authorize.mock.calls[0]?.[2]).toContain("mcp:skills.read");
	});

	it("round-trips an opaque keyset cursor for approval requests", async () => {
		const first = await poll({
			name: "work.approval.requested",
			arguments: { organization_id: ORG_A, work_item_id: ITEM },
			cursor: null,
		});
		expect(first.cursor).toMatch(/^war1\./);
		await poll({
			name: "work.approval.requested",
			arguments: { organization_id: ORG_A, work_item_id: ITEM },
			cursor: first.cursor,
		});
		expect(api.mcpEvents.pollWorkApprovalRequests).toHaveBeenCalledWith({
			after: { at: "2026-10-15T12:00:00.000Z", id: "p1" },
			workItemId: ITEM,
			approverId: undefined,
			limit: 50,
		});
	});

	it("rejects unknown events, foreign cursors and undeclared arguments before any read", async () => {
		await expect(
			poll({ name: "email.received", arguments: {}, cursor: null }),
		).rejects.toMatchObject({ code: -32023 });
		await expect(
			poll({
				name: "work.approval.requested",
				arguments: { organization_id: ORG_A },
				cursor: "wsc1.3",
			}),
		).rejects.toBeInstanceOf(InteractionEventError);
		await expect(
			poll({
				name: "work.item.state_changed",
				arguments: { organization_id: ORG_A, tedi_id: ITEM },
				cursor: null,
			}),
		).rejects.toMatchObject({ code: -32602 });
		expect(authorize).toHaveBeenCalledTimes(1);
	});
});
