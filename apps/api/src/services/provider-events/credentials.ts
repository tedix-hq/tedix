import { fetchNamedTenantConnectionToken } from "@tedix/auth/connections";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import type { BaseContext } from "../../rpc/orpc";
import type { Subscription } from "./types";
export async function assertProviderEventTarget(
	context: BaseContext,
	subscription: Pick<
		Subscription,
		"organizationId" | "tediId" | "skillId" | "skillRevision"
	>,
) {
	const [tedi, skill] = await Promise.all([
		getTediByIdForOrganization(
			context.db,
			subscription.tediId,
			subscription.organizationId,
		),
		getSkillEntry(
			context.db,
			subscription.skillId,
			subscription.organizationId,
		),
	]);
	if (
		!tedi ||
		tedi.status !== "active" ||
		tedi.runtimeState === "archived" ||
		!skill ||
		skill.tediId !== subscription.tediId ||
		!["active", "proven", "crystallized"].includes(
			skill.lifecycleState ?? "",
		) ||
		skill.revision !== subscription.skillRevision ||
		!skill.files?.["scripts/workflow.ts"]
	)
		throw new Error("Active organization-owned tedi skill required");
}
export async function resolveProviderEventCredential(
	context: BaseContext,
	subscription: Pick<
		Subscription,
		| "organizationId"
		| "providerId"
		| "connectionInstanceId"
		| "adapter"
		| "tediId"
		| "skillId"
		| "skillRevision"
	>,
) {
	await assertProviderEventTarget(context, subscription);
	const tenantId = await getOrganizationDescopeTenantId(
		context.db,
		subscription.organizationId,
	);
	if (!tenantId) throw new Error("Organization connection tenant unavailable");
	const scopes =
		subscription.adapter === "google_calendar"
			? ["https://www.googleapis.com/auth/calendar.readonly"]
			: ["Calendars.Read"];
	if (!subscription.connectionInstanceId)
		throw new Error(
			"Exact named organization account required; default account fallback is disabled",
		);
	const instance = await getConnectionInstance(
		context.db,
		{ organizationId: subscription.organizationId },
		subscription.connectionInstanceId,
		subscription.providerId,
	);
	if (!instance || !instance.tokenIds.length)
		throw new Error(
			"Connected organization-owned account required; personal delegation is not enabled",
		);
	const token = await fetchNamedTenantConnectionToken(context.env, {
		appId: subscription.providerId,
		tenantId,
		externalIdentifier: `tedix_${instance.id}`,
		scopes,
	});

	if (
		!token?.accessToken ||
		(token.expiresAt && token.expiresAt <= Date.now() / 1000)
	)
		throw new Error(
			"Calendar connection is missing, expired or lacks required scope",
		);
	return token.accessToken;
}
