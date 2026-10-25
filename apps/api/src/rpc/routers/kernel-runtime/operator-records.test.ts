import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createRouterClient } from "@orpc/server";
import type { BaseContext } from "../../orpc";
import { OPERATOR_RECORD_TOOLS } from "@tedix/api-contract/schemas/operator-records";

const mocks = vi.hoisted(() => ({
	home: vi.fn(),
	consent: vi.fn(),
	member: vi.fn(),
	tedi: vi.fn(),
	attempts: vi.fn(),
	access: vi.fn(),
	history: vi.fn(),
	assemble: vi.fn(),
	event: vi.fn(),
	memory: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/platform-facts", () => ({
	getTopPlatformFacts: mocks.memory,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: mocks.home,
}));
vi.mock("@tedix/db/queries/personal-request-consent", () => ({
	getPersonalRequestConsent: mocks.consent,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberByUserId: mocks.member,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: mocks.attempts,
}));
vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	insertTediRuntimeEvent: mocks.event,
}));
vi.mock("../../../kernel/conversation-access", () => ({
	resolveKernelConversationAccess: mocks.access,
}));
vi.mock("../kernel/context-history", () => ({
	fetchConversationHistory: mocks.history,
}));
vi.mock("../kernel/context-assembly", () => ({
	assembleHomeContext: mocks.assemble,
}));
import { readOperatorRecordsRoute } from "./operator-records";

const input = {
	tediId: "tedi",
	runId: "child",
	homeRunId: "home",
	workItemId: "work",
	source: "home" as const,
};
const context = {
	db: {},
	organizationId: "org",
	tediId: "tedi",
	headers: new Headers({
		"X-Service-Binding": "true",
		"X-Tedix-Tedi-Id": "tedi",
	}),
} as BaseContext;
const client = () =>
	createRouterClient({ read: readOperatorRecordsRoute }, { context });
const order = () => ({
	targetTediId: "tedi",
	objective: "Read commitments",
	outputContract: "Return dated sources",
	executionRequirement: {
		surface: "native",
		requiredCapabilities: [],
		fallbackSurface: null,
		prohibitedSurfaces: [],
		reason: "bounded read",
		satisfiable: true,
	},
	contract: {
		successCriteria: ["cite the facts read"],
		budgetHint: "3 calls",
		deadlineHint: "1 min",
		failurePolicy: "partial",
	},
	outputSchema: null,
	sourceContent: "What did I commit to this week?",
	capabilityPlan: {
		version: "delegation-capabilities.v1",
		requiredCapabilities: ["operator.records.read"],
		allowedToolIds: [...OPERATOR_RECORD_TOOLS],
		missingCapabilities: [],
		urls: [],
		outputIds: [],
	},
});
let home: ReturnType<typeof homeRecord>;
const homeRecord = () => ({
	id: "home",
	status: "running",
	conversationId: "home:caller",
	delegatedTediId: "tedi",
	childRunId: "child",
	metadata: {
		workItemId: "work",
		kernelRoute: { risk: "low" },
		homeDelegation: { workOrder: order() },
	},
});
beforeEach(() => {
	vi.clearAllMocks();
	home = homeRecord();
	mocks.home.mockImplementation(async () => home);
	mocks.consent.mockResolvedValue({
		actorId: "caller",
		timestamp: new Date(),
		metadata: {
			requesterUserId: "caller",
			rootRunId: "home",
			conversationId: "home:caller",
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
	});
	mocks.member.mockResolvedValue({
		id: "member",
		userId: "caller",
		status: "active",
	});
	mocks.tedi.mockResolvedValue({
		id: "tedi",
		scope: "personal",
		ownerUserId: "caller",
	});
	mocks.attempts.mockResolvedValue({
		data: [
			{
				executorType: "tedi",
				executorId: "tedi",
				runId: "child",
				runtimeState: "running",
				expiresAt: new Date(Date.now() + 60000).toISOString(),
			},
		],
	});
	mocks.access.mockResolvedValue({ allowed: true });
	mocks.history.mockResolvedValue({
		messages: [{ role: "user", content: "I promised a draft on Friday" }],
	});
	mocks.event.mockResolvedValue({ id: "event" });
});
describe("delegated operator records", () => {
	it("reads as the persisted member and records the grant source", async () => {
		const result = await client().read(input);
		expect(result.text).toContain("promised a draft");
		expect(mocks.access).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({
				descopeUserId: "caller",
				conversationId: "home:caller",
			}),
		);
		expect(mocks.event).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({
				payload: expect.objectContaining({
					source: "delegation-operator-records",
					memberId: "member",
				}),
			}),
		);
	});
	it.each(["finished", "cancelled", "failed"])(
		"rejects a %s parent",
		async (status) => {
			home.status = status;
			await expect(client().read(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			expect(mocks.history).not.toHaveBeenCalled();
		},
	);
	it.each(["childRunId", "delegatedTediId"])(
		"rejects a forged %s",
		async (key) => {
			home[key] = "other";
			await expect(client().read(input)).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		},
	);
	it("rejects missing human admission", async () => {
		mocks.consent.mockResolvedValue(null);
		await expect(client().read(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rejects expired consent", async () => {
		const consent = await mocks.consent();
		consent.metadata.expiresAt = "2020-01-01T00:00:00Z";
		await expect(client().read(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rejects a private tedi owned by another member", async () => {
		mocks.tedi.mockResolvedValue({
			id: "tedi",
			scope: "personal",
			ownerUserId: "other",
		});
		await expect(client().read(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rejects a conversation the member cannot read", async () => {
		mocks.access.mockResolvedValue({ allowed: false });
		await expect(
			client().read({ ...input, conversationId: "private:other" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.history).not.toHaveBeenCalled();
	});
	it("rejects a missing current Attempt", async () => {
		mocks.attempts.mockResolvedValue({ data: [] });
		await expect(client().read(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("allows only the member-owned tedi's private memory alongside organization facts", async () => {
		const fact = {
			organizationId: "org",
			content: "Commitment",
			visibility: "private",
			reviewStatus: "confirmed",
			memoryScope: "tedi",
			usePolicy: "can_use_as_evidence",
			confidence: 1,
		};
		mocks.memory.mockResolvedValue([
			{ fact: { ...fact, id: "own", tediId: "tedi" } },
			{ fact: { ...fact, id: "other", tediId: "other" } },
			{ fact: { ...fact, id: "org", visibility: "org", tediId: null } },
		]);
		const result = await client().read({
			...input,
			source: "memory",
			query: "Commitment",
		});
		expect(
			JSON.parse(result.text).facts.map((row: { id: string }) => row.id),
		).toEqual(["own", "org"]);
	});
	it("rejects a write-bearing capability plan", async () => {
		home.metadata.homeDelegation.workOrder.capabilityPlan.allowedToolIds.push(
			"send_email",
		);
		await expect(client().read(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
