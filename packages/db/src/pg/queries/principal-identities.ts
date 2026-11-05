import { and, eq, isNull } from "drizzle-orm";
import type { PrincipalType } from "../../schema/principal-identities";
import type { PgQueryClient } from "../query-client";
import { principalIdentities } from "../schema/principal-identities";

export interface ExternalIdentity {
	provider: string;
	issuer: string;
	subject: string;
}

export interface CanonicalPrincipal {
	principalType: PrincipalType;
	principalId: string;
	organizationId?: string | null;
}

function normalizeExternalIdentity(
	identity: ExternalIdentity,
): ExternalIdentity {
	const provider = identity.provider.trim().toLowerCase();
	const issuer = identity.issuer.trim().replace(/\/+$/, "");
	const subject = identity.subject.trim();
	if (!provider || !issuer || !subject) {
		throw new Error(
			"External identity provider, issuer, and subject are required",
		);
	}
	return { provider, issuer, subject };
}

export async function resolvePrincipalIdentity(
	db: PgQueryClient,
	identity: ExternalIdentity,
	options?: {
		principalType?: PrincipalType;
		organizationId?: string | null;
		includeRevoked?: boolean;
	},
) {
	const external = normalizeExternalIdentity(identity);
	const [row] = await db
		.select()
		.from(principalIdentities)
		.where(
			and(
				eq(principalIdentities.provider, external.provider),
				eq(principalIdentities.issuer, external.issuer),
				eq(principalIdentities.subject, external.subject),
				options?.includeRevoked
					? undefined
					: eq(principalIdentities.status, "active"),
				options?.principalType
					? eq(principalIdentities.principalType, options.principalType)
					: undefined,
				options && "organizationId" in options
					? options.organizationId === null ||
						options.organizationId === undefined
						? isNull(principalIdentities.organizationId)
						: eq(principalIdentities.organizationId, options.organizationId)
					: undefined,
			),
		)
		.limit(1);
	return row;
}

export async function listPrincipalIdentities(
	db: PgQueryClient,
	principal: CanonicalPrincipal,
) {
	return db
		.select()
		.from(principalIdentities)
		.where(
			and(
				eq(principalIdentities.principalType, principal.principalType),
				eq(principalIdentities.principalId, principal.principalId),
				principal.organizationId === undefined
					? undefined
					: principal.organizationId === null
						? isNull(principalIdentities.organizationId)
						: eq(principalIdentities.organizationId, principal.organizationId),
			),
		);
}
