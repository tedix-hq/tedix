import { z } from "zod";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import { fetchNamedTenantConnectionToken } from "@tedix/auth/connections";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { getOsOutput } from "@tedix/db/queries/os-workspaces/outputs";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { guardedFetch } from "@tedix/ssrf-guard";
import type { BaseContext } from "../rpc/orpc";
import { resolveKernelConversationAccess } from "./conversation-access";
import type { KernelAcceptanceReader } from "./request-coordinator";

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const runSchema = z.object({
	id: z.number().int(),
	conclusion: z.string().nullable(),
	html_url: z.url(),
	updated_at: z.iso.datetime(),
});
const jobsSchema = z.object({
	jobs: z
		.array(
			z.object({ id: z.number().int(), conclusion: z.string().nullable() }),
		)
		.max(100),
});
const manifestSchema = z.object({
	repository: z.string(),
	commitSha: shaSchema,
	surface: z.string(),
	/** The live surface publishes its own build identity, not an org-wide health result. */
	deploymentRunId: z.number().int(),
});

type Target = KernelRequestPolicy["repositoryTargets"][number];

/** Uses the stored source owner as an ACL subject, never as an OAuth or tool grant. */
export function kernelAcceptanceReader(
	context: BaseContext,
	source: {
		organizationId: string;
		ownerUserId: string;
		conversationId: string | null;
		sourceId?: string;
	},
	policy: KernelRequestPolicy,
	fetchFn: typeof fetch = fetch,
): KernelAcceptanceReader {
	async function assertSourceAccess() {
		const member = await getMemberByUserId(
			context.db,
			source.organizationId,
			source.ownerUserId,
		);
		if (member?.status !== "active")
			throw new Error("Source owner is not an active member");
		if (
			source.conversationId &&
			!(
				await resolveKernelConversationAccess(context.db, {
					organizationId: source.organizationId,
					conversationId: source.conversationId,
					descopeUserId: source.ownerUserId,
					required: "read",
				})
			).allowed
		)
			throw new Error("Source conversation access revoked");
	}
	return {
		async readHomeResponse() {
			await assertSourceAccess();
			if (!source.sourceId || !source.conversationId)
				throw new Error("Home source unavailable");
			const run = await getKernelRuntimeRun(context.db, {
				organizationId: source.organizationId,
				id: source.sourceId,
			});
			if (
				run?.status !== "completed" ||
				run.conversationId !== source.conversationId ||
				!run.outputMessageId
			)
				throw new Error("Home response is not settled");
			const workItemId =
				run.metadata?.workItemId ?? run.runtimeMetadata?.workItemId;
			if (typeof workItemId !== "string")
				throw new Error("Canonical Work unavailable");
			const work = await getWorkItemById(
				context.db,
				workItemId,
				source.organizationId,
			);
			const attempt = (
				await listWorkItemAttempts(context.db, {
					orgId: source.organizationId,
					workItemId,
					limit: 1,
				})
			).data[0];
			if (
				!work ||
				work.disposition === "cancelled" ||
				attempt?.outcome !== "succeeded"
			)
				throw new Error("Canonical Work is not settled");
			const events = await listKernelRuntimeEvents(context.db, {
				organizationId: source.organizationId,
				runId: source.sourceId,
				order: "desc",
				limit: 100,
			});
			const response = events.find(
				(e) =>
					e.kind === "message.completed" &&
					e.conversationId === source.conversationId &&
					e.messageId === run.outputMessageId &&
					e.payload?.role === "assistant" &&
					typeof e.payload.content === "string" &&
					e.payload.content.trim().length > 0 &&
					Date.parse(e.createdAt) >= Date.parse(attempt.startedAt),
			);
			if (!response) throw new Error("Durable Home reply unavailable");
			return { attemptId: attempt.id, receiptRef: response.id };
		},
		async readOutputRevision(check) {
			await assertSourceAccess();
			const output = await getOsOutput(context.db, {
				organizationId: source.organizationId,
				outputId: check.outputId,
			});
			if (!output || output.status !== "active")
				throw new Error("Output unavailable");
			if (output.workspaceId) {
				const workspace = await getOsWorkspace(context.db, {
					organizationId: source.organizationId,
					workspaceId: output.workspaceId,
				});
				if (
					!workspace ||
					!isOsWorkspaceVisibleTo(workspace, { userIds: [source.ownerUserId] })
				)
					throw new Error("Output access denied");
			}
			if (!output.currentRevisionId) throw new Error("Output has no revision");
			return {
				revisionId: output.currentRevisionId,
				evidenceRef: `os-output:${output.id}:revision:${output.currentRevisionId}`,
			};
		},
		async readRepositoryDelivery(check) {
			await assertSourceAccess();
			return readConfiguredRepositoryDelivery(
				context,
				source.organizationId,
				policy,
				check,
				fetchFn,
			);
		},
	};
}

/** Trusted service reader; callers authorize the source or timer policy before using it. */
export async function readConfiguredRepositoryDelivery(
	context: BaseContext,
	organizationId: string,
	policy: KernelRequestPolicy,
	check: Parameters<KernelAcceptanceReader["readRepositoryDelivery"]>[0],
	fetchFn: typeof fetch = fetch,
) {
	const target = policy.repositoryTargets.find(
		(t) => t.id === check.targetId && t.surface === check.surface,
	);
	if (!target) throw new Error("Repository target is not configured");
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "Tedix-kernel-acceptance",
	};
	const token = await githubToken(context, organizationId, target);
	if (token) headers.Authorization = `Bearer ${token}`;
	const github = async (path: string) => {
		const response = await guardedFetch(
			`https://api.github.com/repos/${path}`,
			{ headers, signal: AbortSignal.timeout(policy.probeTimeoutMs) },
			{ fetchFn },
		);
		if (!response.ok) throw new Error("GitHub target unavailable");
		return response;
	};
	const main = z
		.object({ sha: shaSchema })
		.parse(await (await github(`${target.repository}/commits/main`)).json());
	const runs = z
		.object({ workflow_runs: z.array(runSchema) })
		.parse(
			await (
				await github(
					`${target.shipRepository}/actions/workflows/${target.workflowId}/runs?status=completed&per_page=3`,
				)
			).json(),
		);
	const liveResponse = await guardedFetch(
		target.liveManifestUrl,
		{ signal: AbortSignal.timeout(policy.probeTimeoutMs) },
		{ fetchFn, allowTedixHosts: true, maxRedirects: 0 },
	);
	if (!liveResponse.ok) throw new Error("Live surface manifest unavailable");
	const live = manifestSchema.parse(await liveResponse.json());
	if (live.repository !== target.repository || live.surface !== target.surface)
		throw new Error("Live manifest target mismatch");
	const run = runs.workflow_runs.find(
		(r) =>
			r.id === live.deploymentRunId &&
			r.conclusion === "success" &&
			Date.now() - Date.parse(r.updated_at) <= target.maxAgeMs &&
			Date.parse(r.updated_at) <= Date.now(),
	);
	if (!run)
		throw new Error("Live deployment has no fresh successful managed Ship");
	const jobs = jobsSchema.parse(
		await (
			await github(
				`${target.shipRepository}/actions/runs/${run.id}/jobs?per_page=20`,
			)
		).json(),
	);
	const receipt = `verified: ${check.surface} is live on ${check.commitSha}`;
	for (const job of jobs.jobs.slice(0, 20)) {
		if (job.conclusion !== "success") continue;
		const logs = await boundedText(
			await github(`${target.shipRepository}/actions/jobs/${job.id}/logs`),
		);
		if (!logs.split("\n").some((line) => line.trimEnd().endsWith(receipt)))
			continue;
		return {
			mainSha: main.sha,
			shipSha: check.commitSha,
			shipStatus: "success",
			liveSha: live.commitSha,
			surface: live.surface,
			evidenceRefs: [
				run.html_url,
				`${run.html_url}/job/${job.id}`,
				target.liveManifestUrl,
			],
		};
	}
	throw new Error("Managed Ship has no exact product SHA and surface receipt");
}

async function githubToken(
	context: BaseContext,
	organizationId: string,
	target: Target,
) {
	if (!target.connectionInstanceId) return null;
	const provider = await getConnectionProviderById(context.db, "github");
	if (!provider?.descopeAppId) throw new Error("GitHub provider unavailable");
	const instance = await getConnectionInstance(
		context.db,
		{ organizationId },
		target.connectionInstanceId,
		provider.descopeAppId,
	);
	if (!instance?.tokenIds.length || !instance.tokenSub)
		throw new Error("Verified organization GitHub connection unavailable");
	const token = await fetchNamedTenantConnectionToken(context.env, {
		appId: provider.descopeAppId,
		tenantId:
			(await getOrganizationDescopeTenantId(context.db, organizationId)) ?? "",
		externalIdentifier: `tedix_${instance.id}`,
	});
	if (
		!token?.id ||
		!instance.tokenIds.includes(token.id) ||
		token.tokenSub !== instance.tokenSub
	)
		throw new Error("GitHub connection identity changed");
	return token.accessToken;
}

async function boundedText(response: Response) {
	if (!response.body) throw new Error("Empty deployment log");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "",
		size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return text + decoder.decode();
			size += chunk.value.byteLength;
			if (size > 1_000_000)
				throw new Error("Deployment log exceeds probe budget");
			text += decoder.decode(chunk.value, { stream: true });
		}
	} finally {
		await reader.cancel();
	}
}
