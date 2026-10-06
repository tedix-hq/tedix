import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { CreateWorkItemInputSchema } from "@tedix/api-contract/schemas/work-items";
import type { DbClient } from "@tedix/db/client";
import assurance from "./agent-surface-assurance.fixture.json";
import {
	compileFactoryCycle,
	prepareFactoryCycle,
	replayFactoryCycle,
	readFactoryCycle,
	requireFactoryAcceptance,
	requireFactoryAdmission,
} from "./factory-cycle";

vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: vi.fn(),
}));
vi.mock("@tedix/db/queries/os-workspaces/blueprints", () => ({
	getOsBlueprintRevision: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemBySourceIntentId: vi.fn(),
}));
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getOsBlueprintRevision } from "@tedix/db/queries/os-workspaces/blueprints";
import { getWorkItemBySourceIntentId } from "@tedix/db/queries/work-items/crud";

const workspaceId = "e3cfb2ce-cc50-4ca6-a98c-f74b870ffb00";
const revisionId = "53d33350-8cc0-4673-ae19-98fc2f64b897";
const db = {} as DbClient;
const factory = OsBlueprintDefinitionSchema.parse(assurance).factory!;
function request(templateKey = "deliverable", instance = workspaceId) {
	return CreateWorkItemInputSchema.parse({
		title: "Derived on server",
		projectId: workspaceId,
		objectiveId: revisionId,
		factoryCycle: {
			workspaceId: instance,
			blueprintRevisionId: revisionId,
			templateKey,
			cycleKey: "2026-08-28T00:00Z",
			sourceRefs: [{ uri: "git:tedix", revision: "abc123" }],
		},
	});
}
async function compile(template = "deliverable", instance = workspaceId) {
	return compileFactoryCycle({
		request: request(template, instance),
		factory,
		definitionDigest: "definition-a",
	});
}
beforeEach(() => vi.resetAllMocks());

describe("Factory Blueprint v0", () => {
	it("validates a domain preset without special engine branches", () => {
		expect(
			OsBlueprintDefinitionSchema.parse(assurance).factory?.templates,
		).toHaveLength(2);
	});
	// Independent review is no longer required of a blueprint claim
	// (docs/decisions/minimal-gates-over-pre-proof.md), so only the deliverable
	// template count is still enforced here.
	it("rejects a blueprint that declares no deliverable template", () => {
		const invalid = structuredClone(assurance);
		invalid.factory.templates = [invalid.factory.templates[0]!];
		expect(OsBlueprintDefinitionSchema.safeParse(invalid).success).toBe(false);
	});
	it("normal: derives bounded proposed Work, not runtime authority", async () => {
		const proposal = await compile();
		// The kind comes from the fixture blueprint (agent-surface-assurance).
		expect(proposal.workKind).toBe("browser");
		expect(proposal.requiredAuthorities).toEqual([]);
		expect(proposal).not.toHaveProperty("disposition");
		expect(
			readFactoryCycle(proposal.metadata!)?.admissionSpecification.resources,
		).toEqual([{ resourceKey: `factory:${workspaceId}`, quantity: 1 }]);
	});
	it("no-work remains a reviewed negative finding", async () => {
		const cycle = readFactoryCycle((await compile("no_work")).metadata!)!;
		expect(cycle.outcome).toBe("no_work");
	});
	it("duplicate: identical cycle replays; changed inputs conflict", async () => {
		const proposal = await compile();
		const winner = { metadata: proposal.metadata } as NonNullable<
			Awaited<ReturnType<typeof getWorkItemBySourceIntentId>>
		>;
		vi.mocked(getWorkItemBySourceIntentId).mockResolvedValue(winner);
		expect(await replayFactoryCycle(db, "org", await compile())).toBe(winner);
		const changed = request();
		changed.factoryCycle!.sourceRefs[0]!.revision = "different";
		const conflict = await compileFactoryCycle({
			request: changed,
			factory,
			definitionDigest: "definition-a",
		});
		expect(conflict.sourceIntentId).toBe(proposal.sourceIntentId);
		await expect(replayFactoryCycle(db, "org", conflict)).rejects.toThrow(
			"different inputs",
		);
	});
	it("second instance has an independent source intent and resource", async () => {
		const a = await compile();
		const b = await compile("deliverable", revisionId);
		expect(a.sourceIntentId).not.toBe(b.sourceIntentId);
		expect(readFactoryCycle(a.metadata!)?.admissionSpecification).not.toEqual(
			readFactoryCycle(b.metadata!)?.admissionSpecification,
		);
	});
	it("interruption and rejection cannot exceed retry cap or change acceptance", async () => {
		const metadata = (await compile()).metadata!;
		const cycle = readFactoryCycle(metadata)!;
		const admission = {
			metadata,
			execution: cycle.execution,
			specification: cycle.admissionSpecification,
			attemptCount: 1,
		};
		expect(() => requireFactoryAdmission(admission)).not.toThrow();
		expect(() =>
			requireFactoryAdmission({ ...admission, attemptCount: 2 }),
		).toThrow("retry budget");
		expect(() =>
			requireFactoryAcceptance(metadata, cycle.acceptanceContract),
		).not.toThrow();
		expect(() =>
			requireFactoryAcceptance(metadata, {
				...cycle.acceptanceContract,
				doneLooksLike: "Done when the named outcome is delivered",
			}),
		).toThrow("pinned template");
		expect(() =>
			requireFactoryAdmission({
				...admission,
				specification: { resources: [], budget: null },
			}),
		).toThrow("declared resource");
	});
	it("rejects forged provenance and foreign or changed workspace pins", async () => {
		await expect(
			prepareFactoryCycle(db, "org", {
				...request(),
				metadata: { factoryCycle: {} },
			}),
		).rejects.toThrow("server-derived");
		vi.mocked(getOsWorkspace).mockResolvedValue(undefined);
		await expect(prepareFactoryCycle(db, "org", request())).rejects.toThrow(
			"not found",
		);
		expect(getOsWorkspace).toHaveBeenCalledWith(db, {
			organizationId: "org",
			workspaceId,
		});
		vi.mocked(getOsWorkspace).mockResolvedValue({
			status: "active",
			sourceBlueprintRevisionId: "other",
		} as Awaited<ReturnType<typeof getOsWorkspace>>);
		await expect(prepareFactoryCycle(db, "org", request())).rejects.toThrow(
			"revision changed",
		);
		expect(getOsBlueprintRevision).not.toHaveBeenCalled();
	});
	it("bounds inputs and keeps ordinary Work unchanged", async () => {
		const ordinary = CreateWorkItemInputSchema.parse({ title: "ordinary" });
		expect(await prepareFactoryCycle(db, "org", ordinary)).toBe(ordinary);
		const duplicate = request();
		duplicate.factoryCycle!.sourceRefs.push(
			duplicate.factoryCycle!.sourceRefs[0]!,
		);
		await expect(
			compileFactoryCycle({
				request: duplicate,
				factory,
				definitionDigest: "a",
			}),
		).rejects.toThrow("unique");
	});
});
