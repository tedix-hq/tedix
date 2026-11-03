import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	repositoryCandidateDocKey,
	repositoryCandidateRoomName,
} from "@tedix/api-contract/utils/repository-candidate";
const mocks = vi.hoisted(() => ({
	work: vi.fn(),
	attempt: vi.fn(),
	admission: vi.fn(),
	member: vi.fn(),
	canonicalMember: vi.fn(),
	session: vi.fn(),
	tedi: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/external-agent-identity/sessions", () => ({
	resolveActiveExternalAgentSession: mocks.session,
}));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediById: mocks.tedi }));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	getRecordedWorkItemAttempt: mocks.attempt,
	getWorkAttemptRepositoryAdmission: mocks.admission,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getMemberAccessByUserId: mocks.member,
	getMemberByCanonicalUserId: mocks.canonicalMember,
}));
import { repositoryCandidateAccess } from "./work-repository-candidate-access";

const workItemId = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222",
	admissionId = "33333333-3333-4333-8333-333333333333";
const identity = {
	organizationId: "org",
	workItemId,
	attemptId,
	admissionId,
	baseRevision: "a".repeat(40),
	selectionDigest: "b".repeat(64),
};
const descriptor = {
	version: 1,
	...identity,
	repositoryId: "repo",
	repositoryName: "fixture",
	files: [{ path: "README.md", blobRevision: "c".repeat(40), bytes: 1 }],
	roomName: repositoryCandidateRoomName(identity),
	docKey: repositoryCandidateDocKey(identity),
	createdAt: "2026-11-01T00:00:00.000Z",
};
const repository = {
	version: 1,
	provider: "cloudflare_artifacts",
	status: "ready",
	mode: "create",
	repositoryId: "repo",
	repositoryName: "fixture",
	remote: "https://artifacts.example/fixture.git",
	defaultBranch: "main",
	sourceRepositoryName: null,
	sourceRef: null,
	baseRevision: null,
	workItemId,
	workItemVersion: 1,
	admissionSpecRevision: "spec",
	admissionId,
	attemptId,
	observedAt: "2026-11-01T00:00:00.000Z",
	reason: null,
};
const work = {
	id: workItemId,
	orgId: "org",
	disposition: "accepted",
	admissionSpecRevision: "spec",
	completedAt: null,
	cancelledAt: null,
};
const attempt = {
	id: attemptId,
	orgId: "org",
	workItemId,
	admissionId,
	runtimeState: "running",
	executorType: "tedi",
	executorId: "fixture-tedi",
	expiresAt: "2099-01-01T00:00:00.000Z",
	metadata: { repository, repositoryCandidate: descriptor },
};
function call(input: unknown = { descriptor, userIds: ["browser"] }) {
	return repositoryCandidateAccess(
		new Request("https://api.internal/__internal/repository-candidate-access", {
			method: "POST",
			body: JSON.stringify(input),
		}),
		{ DB: {} } as Pick<CloudflareEnv, "DB">,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.work.mockResolvedValue(work);
	mocks.attempt.mockResolvedValue(attempt);
	mocks.admission.mockResolvedValue({ admissionSpecRevision: "spec" });
	mocks.member.mockResolvedValue({ role: "owner", status: "active" });
	mocks.canonicalMember.mockResolvedValue(undefined);
	mocks.tedi.mockResolvedValue({ organizationId: "org", retiredAt: null });
	mocks.session.mockResolvedValue({
		session: { externalSessionKey: "verified-fence" },
	});
});
describe("retained repository socket access", () => {
	it("honors canonical provider-independent membership without stale subject fallback", async () => {
		mocks.canonicalMember.mockResolvedValueOnce({
			role: "admin",
			status: "active",
		});
		expect(await (await call()).json()).toMatchObject({
			roles: { browser: "build" },
		});
		mocks.member.mockClear();
		mocks.canonicalMember.mockResolvedValueOnce({
			role: "member",
			status: "active",
		});
		expect(await (await call()).json()).toMatchObject({
			roles: { browser: null },
		});
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it("does not keep external-agent sockets after principal or session revocation", async () => {
		mocks.attempt.mockResolvedValue({
			...attempt,
			executorType: "external_agent",
			executorId: "principal",
			executorSessionId: "session",
			externalSessionKey: "verified-fence",
		});
		expect(await (await call()).json()).toMatchObject({ allowed: true });
		mocks.session.mockResolvedValueOnce(null);
		expect(await (await call()).json()).toMatchObject({ allowed: false });
		mocks.session.mockResolvedValueOnce({
			session: { externalSessionKey: "different" },
		});
		expect(await (await call()).json()).toMatchObject({ allowed: false });
	});
	it("rejects retired tedis without granting a human independent executor authority", async () => {
		mocks.tedi.mockResolvedValue({
			organizationId: "org",
			retiredAt: "2026-11-01",
		});
		expect(await (await call()).json()).toMatchObject({ allowed: false });
	});
	it("revalidates exact Work/Attempt scope and live owner membership", async () => {
		expect(await (await call()).json()).toEqual({
			allowed: true,
			roles: { browser: "build" },
			expiresAt: attempt.expiresAt,
		});
		expect(mocks.work).toHaveBeenCalledWith(
			expect.anything(),
			workItemId,
			"org",
		);
		expect(mocks.attempt).toHaveBeenCalledWith(expect.anything(), {
			orgId: "org",
			workItemId,
			attemptId,
		});
	});
	it.each([
		{ role: "member", status: "active" },
		{ role: "owner", status: "disabled" },
		undefined,
	])("revokes socket role when membership changes", async (member) => {
		mocks.member.mockResolvedValue(member);
		expect(await (await call()).json()).toMatchObject({
			roles: { browser: null },
		});
	});
	it("supports a trusted native scope-only check without granting any socket role", async () => {
		expect(await (await call({ descriptor, userIds: [] })).json()).toEqual({
			allowed: true,
			roles: {},
			expiresAt: attempt.expiresAt,
		});
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it("rejects changed descriptor and admission instead of authorizing retained sockets", async () => {
		expect(
			await (
				await call({
					descriptor: { ...descriptor, baseRevision: "d".repeat(40) },
					userIds: ["browser"],
				})
			).json(),
		).toMatchObject({ allowed: false });
		mocks.admission.mockResolvedValue({ admissionSpecRevision: "other" });
		expect(await (await call()).json()).toMatchObject({ allowed: false });
		expect(mocks.member).not.toHaveBeenCalled();
	});
	it("expires active sockets when Work closes or the Attempt lease ends", async () => {
		mocks.work.mockResolvedValueOnce({ ...work, completedAt: "2026-11-01" });
		expect(await (await call()).json()).toMatchObject({ allowed: false });
		mocks.attempt.mockResolvedValueOnce({
			...attempt,
			expiresAt: "2000-01-01T00:00:00.000Z",
		});
		expect(await (await call()).json()).toMatchObject({ allowed: false });
	});
});
