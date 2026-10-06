import {
	parseRepoCommitWritePayload,
	REPO_COMMIT_WRITE_KIND,
	type RepoCommitWritePayload,
} from "@tedix/api-contract/schemas/repo-commit-write";
import { getTediById } from "@tedix/db/queries/tedis";
import { drainRepoCommitApproval } from "@tedix/provisioning";
import type { BaseContext } from "../../orpc";
import { getProvisioningConfig } from "../tedis/helpers";
import { errorMessage } from "./runtime-shared";

export async function settleRepoCommitApprovalIfNeeded(
	context: BaseContext,
	input: {
		approval: {
			id: string;
			orgId: string;
			payload: unknown;
		};
		status: "approved" | "cancelled" | "rejected";
	},
): Promise<boolean> {
	if (
		input.approval.payload === null ||
		typeof input.approval.payload !== "object" ||
		Array.isArray(input.approval.payload) ||
		(input.approval.payload as Record<string, unknown>).kind !==
			REPO_COMMIT_WRITE_KIND
	) {
		return false;
	}

	const payload = parseRepoCommitWritePayload(input.approval.payload);
	if (!payload || payload.organizationId !== input.approval.orgId) {
		console.warn("[kernelRuntime] repo_commit approval payload invalid", {
			approvalRequestId: input.approval.id,
		});
		return true;
	}

	const drainPromise = triggerRepoCommitDrainFromApproval(context, {
		approvalId: input.approval.id,
		payload,
		status: input.status,
	});
	if (context.waitUntil) {
		context.waitUntil(drainPromise);
	} else {
		await drainPromise;
	}
	return true;
}

async function triggerRepoCommitDrainFromApproval(
	context: BaseContext,
	input: {
		approvalId: string;
		payload: RepoCommitWritePayload;
		status: "approved" | "cancelled" | "rejected";
	},
): Promise<void> {
	try {
		const tedi = await getTediById(context.db, input.payload.tediId);
		if (!tedi?.slug || tedi.organizationId !== input.payload.organizationId) {
			console.warn("[kernelRuntime] repo_commit drain: tedi route not found", {
				approvalRequestId: input.approvalId,
				tediId: input.payload.tediId,
			});
			return;
		}
		const config = getProvisioningConfig({ slug: tedi.slug }, context.env);
		if (!config?.fetcher && !config?.isDev) {
			console.warn(
				"[kernelRuntime] repo_commit drain: runtime route unavailable",
				{
					approvalRequestId: input.approvalId,
					tediId: input.payload.tediId,
				},
			);
			return;
		}
		const result = await drainRepoCommitApproval(config, {
			approvalRequestId: input.approvalId,
			executionLedgerId: input.payload.executionLedgerId,
			status: input.status,
		});
		if (!result.ok) {
			console.warn("[kernelRuntime] repo_commit drain failed", {
				approvalRequestId: input.approvalId,
				error: result.error ?? result.evidenceEventError ?? "unknown",
			});
		}
	} catch (error) {
		console.warn("[kernelRuntime] repo_commit drain trigger failed", {
			approvalRequestId: input.approvalId,
			error: errorMessage(error),
		});
	}
}
