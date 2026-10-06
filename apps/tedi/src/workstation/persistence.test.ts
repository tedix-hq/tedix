import type {
	WorkstationLeaseRow,
	WorkstationParticipantRow,
	WorkstationRow,
	WorkstationSessionRow,
} from "@tedix/db/schema/workstations";
import { describe, expect, it } from "vite-plus/test";
import {
	workstationLeaseRowToContract,
	workstationParticipantRowToContract,
	workstationRowToContract,
	workstationSessionRowToContract,
} from "./persistence";

describe("workstation persistence normalization", () => {
	it("maps a workstation row without leaking persistence timestamps", () => {
		const row: WorkstationRow = {
			id: "workstation-1",
			profileId: "general",
			orgId: "org-1",
			status: "ready",
			seats: [
				{
					role: "lead",
					slug: "cto",
					tediId: "tedi-1",
					permissionScopes: [],
				},
			],
			capabilities: ["repo", "shell"],
			adapters: ["sandbox-workstation"],
			artifactRefs: [],
			metadata: {},
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		};

		const contract = workstationRowToContract(row);
		expect(contract.organizationId).toBe("org-1");
		expect(contract).not.toHaveProperty("createdAt");
		expect(contract).not.toHaveProperty("orgId");
	});

	it("assembles participants and sessions into the lease contract", () => {
		const participant: WorkstationParticipantRow = {
			id: "participant-1",
			leaseId: "lease-1",
			orgId: "org-1",
			tediId: "tedi-1",
			slug: "cto",
			role: "lead",
			status: "active",
			permissionScopes: [],
			joinedAt: "2026-08-01T00:00:00.000Z",
			leftAt: null,
			metadata: {},
		};
		const session: WorkstationSessionRow = {
			id: "session-1",
			leaseId: "lease-1",
			orgId: "org-1",
			participantId: "participant-1",
			kind: "shell",
			adapter: "sandbox-workstation",
			status: "ready",
			sessionKey: null,
			externalId: null,
			artifactRefs: [],
			startedAt: "2026-08-01T00:00:00.000Z",
			endedAt: null,
			metadata: {},
		};
		const lease: WorkstationLeaseRow = {
			id: "lease-1",
			workstationId: "workstation-1",
			profileId: "general",
			orgId: "org-1",
			workItemId: null,
			attemptId: null,
			repositoryPath: null,
			repoStartSha: null,
			preparedStartSha: null,
			kernelRunId: null,
			traceBundleId: null,
			status: "active",
			capabilities: ["shell"],
			adapters: ["sandbox-workstation"],
			approvalIds: [],
			artifactRefs: [],
			metadata: {},
			bodyGenerationId: null,
			bodyGenerationKind: null,
			bodyGenerationStatus: null,
			bodyGenerationTokenHash: null,
			bodyGenerationTokenExpiresAt: null,
			bodyGenerationExternalId: null,
			bodyGenerationHeartbeatAt: null,
			bodyInstanceId: null,
			bodyInstanceName: null,
			bodyInstanceObservedAt: null,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			expiresAt: null,
			releasedAt: null,
		};

		const contract = workstationLeaseRowToContract(
			lease,
			[workstationParticipantRowToContract(participant)],
			[workstationSessionRowToContract(session)],
		);
		expect(contract.participants[0]).not.toHaveProperty("orgId");
		expect(contract.sessions[0]).not.toHaveProperty("orgId");
		expect(contract).not.toHaveProperty("bodyGenerationTokenHash");
	});
});
