import {
	PersonalAgentEnrollmentSchema,
	PersonalAgentFindingSchema,
	type PersonalAgentContribution,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { DbClient } from "@tedix/db/client";
import {
	capturePersonalAgentFinding,
	PERSONAL_AGENT_NAMESPACE,
	personalAgentConfigKey,
} from "@tedix/db/queries/personal-agent-inbound";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import { getOrgSecret } from "@tedix/db/queries/organization-secrets";
import {
	decryptSecret,
	timingSafeCompare,
} from "@tedix/db/utils/secrets-encryption";
import { HTTPException } from "hono/http-exception";

export async function receivePersonalAgentFinding(
	db: DbClient,
	masterKey: string,
	input: {
		orgId: string;
		userId: string;
		enrollmentId: string;
		token: string;
		finding: unknown;
		channel: PersonalAgentContribution["sourceChannel"];
	},
) {
	const denied = () =>
		new HTTPException(401, { message: "Invalid or revoked enrollment" });
	const row = await getUserConfig(db, {
		userId: input.userId,
		namespace: PERSONAL_AGENT_NAMESPACE,
		key: personalAgentConfigKey(input.orgId, input.enrollmentId),
	});
	const parsed = PersonalAgentEnrollmentSchema.safeParse(row?.value);
	if (!row || !parsed.success || !parsed.data.active) throw denied();
	const e = parsed.data;
	if (
		e.orgId !== input.orgId ||
		e.representedUserId !== input.userId ||
		e.id !== input.enrollmentId
	)
		throw denied();
	const secret = await getOrgSecret(db, e.orgId, e.secretName);
	if (
		!secret ||
		!timingSafeCompare(
			await decryptSecret(masterKey, e.orgId, secret.encryptedValue),
			input.token,
		)
	)
		throw denied();
	const finding = PersonalAgentFindingSchema.safeParse(input.finding);
	if (!finding.success)
		throw new HTTPException(400, { message: "Invalid finding" });
	const capturedAt = new Date().toISOString();
	const contribution: PersonalAgentContribution = {
		sourceAgentId: e.id,
		sourceAgentName: e.sourceAgentName,
		representedUserId: e.representedUserId,
		sourceChannel: input.channel,
		capturedAt,
		evidenceUrl: finding.data.evidenceUrl,
		externalFindingId: finding.data.externalFindingId,
		kind: finding.data.kind,
	};
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([e.id, finding.data.externalFindingId]),
		),
	);
	const sourceIntentId = `personal-agent:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const result = await capturePersonalAgentFinding(db, {
		enrollment: e,
		revision: row.revision,
		finding: finding.data,
		contribution,
		sourceIntentId,
	});
	if (!result) throw denied();
	return {
		workItemId: result.work.id,
		externalFindingId: finding.data.externalFindingId,
		capturedAt: result.work.createdAt,
		duplicate: result.duplicate,
		disposition: "proposed" as const,
	};
}
