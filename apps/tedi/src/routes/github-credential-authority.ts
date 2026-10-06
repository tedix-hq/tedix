import { createDbClient } from "@tedix/db/client";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import { getWorkstationLeaseBundle } from "@tedix/db/queries/workstations";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { Hono } from "hono";
import type { AppEnv } from "../types";

const LIVE_LEASE_STATUSES = new Set([
	"requested",
	"provisioning",
	"active",
	"degraded",
	"blocked",
]);
const LIVE_PARTICIPANT_STATUSES = new Set(["invited", "active", "paused"]);

type AuthorityRequest = {
	attemptId?: unknown;
	installationId?: unknown;
	leaseId?: unknown;
	organizationId?: unknown;
	repository?: unknown;
	repositoryId?: unknown;
	tediId?: unknown;
	workItemId?: unknown;
	workstationId?: unknown;
};

function requiredString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;
}

function configuredRepository(repoUrl: string | undefined): string | null {
	if (!repoUrl) return null;
	try {
		const url = new URL(repoUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "github.com" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash
		)
			return null;
		const parts = url.pathname
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/, "")
			.split("/");
		return parts.length === 2 && parts.every((part) => /^[\w.-]+$/.test(part!))
			? parts.join("/")
			: null;
	} catch {
		return null;
	}
}

export const githubCredentialAuthority = new Hono<AppEnv>();

githubCredentialAuthority.post(
	"/internal/workstation/github/authorize",
	async (c) => {
		if (!isServiceBinding(c.req.raw.headers))
			return c.json(
				{ authorized: false, reason: "service_binding_required" },
				401,
			);
		if (!c.env.DB)
			return c.json({ authorized: false, reason: "database_unavailable" }, 503);

		let input: AuthorityRequest;
		try {
			input = (await c.req.json()) as AuthorityRequest;
		} catch {
			return c.json({ authorized: false, reason: "invalid_request" }, 400);
		}
		const attemptId = requiredString(input.attemptId);
		const installationId = positiveInteger(input.installationId);
		const leaseId = requiredString(input.leaseId);
		const organizationId = requiredString(input.organizationId);
		const repository = requiredString(input.repository);
		const repositoryId = positiveInteger(input.repositoryId);
		const tediId = requiredString(input.tediId);
		const workItemId = requiredString(input.workItemId);
		const workstationId = requiredString(input.workstationId);
		if (
			!attemptId ||
			!installationId ||
			!leaseId ||
			!organizationId ||
			!repository ||
			!repositoryId ||
			!tediId ||
			!workItemId ||
			!workstationId
		)
			return c.json({ authorized: false, reason: "correlation_missing" }, 403);

		const db = createDbClient(c.env.DB);
		const [organization, tedi, bundle] = await Promise.all([
			getOrganizationById(db, organizationId),
			getTediByIdForOrganization(db, tediId, organizationId),
			getWorkstationLeaseBundle(db, leaseId),
		]);
		if (!organization || !tedi || !bundle)
			return c.json({ authorized: false, reason: "authority_not_found" }, 403);

		const lease = bundle.workstationLease;
		const participant = lease.participants.find(
			(entry) => entry.tediId === tediId,
		);
		if (
			lease.orgId !== organizationId ||
			lease.workstationId !== workstationId ||
			bundle.workstation.id !== workstationId ||
			lease.workItemId !== workItemId ||
			lease.attemptId !== attemptId ||
			!LIVE_LEASE_STATUSES.has(lease.status) ||
			!participant ||
			!LIVE_PARTICIPANT_STATUSES.has(participant.status)
		)
			return c.json({ authorized: false, reason: "lease_fence_mismatch" }, 403);

		try {
			await getAuthoritativeWorkItemAttempt(db, {
				attemptId,
				executor: { type: "tedi", id: tediId },
				orgId: organizationId,
				workItemId,
			});
		} catch {
			return c.json(
				{ authorized: false, reason: "attempt_not_authoritative" },
				403,
			);
		}

		const repoConfig = tedi.repoConfig;
		if (
			tedi.status !== "active" ||
			tedi.retiredAt ||
			repoConfig?.githubAppEnabled !== true ||
			repoConfig.githubRepositoryId !== repositoryId ||
			repoConfig.githubInstallationId !== installationId ||
			configuredRepository(repoConfig.repoUrl)?.toLowerCase() !==
				repository.toLowerCase()
		)
			return c.json(
				{ authorized: false, reason: "repository_authority_mismatch" },
				403,
			);

		const controls = (
			organization.metadata as {
				githubWorkstationCredentials?: {
					enabled?: boolean;
					disabledInstallationIds?: number[];
					disabledRepositoryIds?: number[];
				};
			} | null
		)?.githubWorkstationCredentials;
		if (controls?.enabled !== true)
			return c.json(
				{ authorized: false, reason: "organization_disabled" },
				403,
			);
		if (controls.disabledInstallationIds?.includes(installationId))
			return c.json(
				{ authorized: false, reason: "installation_disabled" },
				403,
			);
		if (controls.disabledRepositoryIds?.includes(repositoryId))
			return c.json({ authorized: false, reason: "repository_disabled" }, 403);

		return c.json({
			authorized: true,
			attemptId,
			installationId,
			repository,
			repositoryId,
		});
	},
);
