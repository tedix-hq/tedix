import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import {
	compileFactoryCycle,
	readFactoryCycle,
} from "../../../services/factory-cycle";
import preset from "../../../services/agent-surface-assurance.fixture.json";
import { admitWorkAttempt } from "./attempt-admission";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import {
	evaluateAndRecordWorkAdmission,
	getWorkAdmissionSpecification,
} from "@tedix/db/queries/work-items/admissions";

vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/admissions", () => ({
	evaluateAndRecordWorkAdmission: vi.fn(),
	getWorkAdmissionSpecification: vi.fn(),
}));

const id = "e3cfb2ce-cc50-4ca6-a98c-f74b870ffb00";
const revision = "53d33350-8cc0-4673-ae19-98fc2f64b897";
const db = {} as Parameters<typeof admitWorkAttempt>[0];
const params = {
	workItem: { id, orgId: id, version: 1, admissionSpecRevision: "spec-1" },
	executor: { type: "tedi" as const, id: revision },
	leaseTtlMs: 300000,
	now: "2026-08-28T00:00:00.000Z",
};
type Item = NonNullable<Awaited<ReturnType<typeof getWorkItemById>>>;

async function fixture() {
	const proposal = await compileFactoryCycle({
		request: CreateWorkItemInputSchema.parse({
			title: "cycle",
			projectId: id,
			objectiveId: revision,
			factoryCycle: {
				workspaceId: id,
				blueprintRevisionId: revision,
				templateKey: "deliverable",
				cycleKey: "scan-a",
				sourceRefs: [{ uri: "git:tedix", revision: "sha-a" }],
			},
		}),
		factory: OsBlueprintDefinitionSchema.parse(preset).factory!,
		definitionDigest: "digest-a",
	});
	const cycle = readFactoryCycle(proposal.metadata!)!;
	const item = {
		...params.workItem,
		...cycle.execution,
		metadata: proposal.metadata,
		acceptanceContract: cycle.acceptanceContract,
	} as Item;
	vi.mocked(getWorkItemById).mockResolvedValue(item);
	vi.mocked(listWorkItemAttempts).mockResolvedValue({
		data: [],
		nextCursor: null,
	});
	vi.mocked(getWorkAdmissionSpecification).mockResolvedValue({
		...cycle.admissionSpecification,
		workItemId: id,
		workItemVersion: 1,
		admissionSpecRevision: "spec-1",
	});
	return item;
}

beforeEach(() => vi.resetAllMocks());
describe("shared factory admission", () => {
	it("uses canonical admission, including approval denials", async () => {
		await fixture();
		vi.mocked(evaluateAndRecordWorkAdmission).mockResolvedValue({
			id: revision,
			decision: "rejected",
			rejectionCode: "approval_blocked",
			rejectionReason: "approval_required",
			expiresAt: params.now,
		} as Awaited<ReturnType<typeof evaluateAndRecordWorkAdmission>>);
		await expect(admitWorkAttempt(db, params)).rejects.toMatchObject({
			code: "CONFLICT",
			message: "approval_required",
			data: { rejectionCode: "approval_blocked", reason: "approval_required" },
		});
		expect(evaluateAndRecordWorkAdmission).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				expectedWorkItemVersion: 1,
				expectedAdmissionSpecRevision: "spec-1",
				executorId: revision,
			}),
		);
	});
	it("returns only the canonical admitted lease", async () => {
		await fixture();
		vi.mocked(evaluateAndRecordWorkAdmission).mockResolvedValue({
			id: revision,
			decision: "admitted",
			expiresAt: "2026-08-28T00:05:00.000Z",
		} as Awaited<ReturnType<typeof evaluateAndRecordWorkAdmission>>);
		expect(await admitWorkAttempt(db, params)).toEqual({
			id: revision,
			expiresAt: "2026-08-28T00:05:00.000Z",
		});
	});
	it("rejects stale reads and retries before issuing a new admission", async () => {
		const item = await fixture();
		vi.mocked(getWorkItemById).mockResolvedValue({ ...item, version: 2 });
		await expect(admitWorkAttempt(db, params)).rejects.toThrow("Work changed");
		vi.mocked(getWorkItemById).mockResolvedValue(item);
		vi.mocked(listWorkItemAttempts).mockResolvedValue({
			data: [{}, {}] as Awaited<
				ReturnType<typeof listWorkItemAttempts>
			>["data"],
			nextCursor: null,
		});
		await expect(admitWorkAttempt(db, params)).rejects.toThrow("retry budget");
		expect(evaluateAndRecordWorkAdmission).not.toHaveBeenCalled();
	});
	it("cannot weaken pinned execution requirements through a Work edit", async () => {
		const item = await fixture();
		vi.mocked(getWorkItemById).mockResolvedValue({ ...item, riskLevel: "low" });
		await expect(admitWorkAttempt(db, params)).rejects.toThrow(
			"pinned template",
		);
		expect(evaluateAndRecordWorkAdmission).not.toHaveBeenCalled();
	});
});
