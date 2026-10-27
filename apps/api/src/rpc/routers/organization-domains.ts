import { implement, ORPCError } from "@orpc/server";
import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import { createDbClient } from "@tedix/db/client";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import {
	getOrganizationDomain,
	reserveOrganizationDomain,
	lockOrganizationDomain,
	finishOrganizationDomainVerification,
	deleteOrganizationDomain,
} from "@tedix/db/queries/organization-domains";
import { AUTHZ, withAuth, type BaseContext } from "../orpc";
import { requireOrgId } from "../org-scope";
import {
	assertCustomHostname,
	createCmsDomainVerificationToken,
	verifyCmsDnsChallenge,
	verifyCmsDnsTarget,
	createCmsCustomHostname,
	findCmsCustomHostname,
	getCmsCustomHostname,
	deleteCmsCustomHostname,
	isCmsCustomHostnameReady,
	type CmsCustomHostname,
} from "../../services/cms-custom-hostnames";
import {
	organizationDomainVerificationName,
	organizationHostnameProvider,
	type OrganizationCustomHostnameEnv,
} from "../../services/organization-custom-hostnames";

const os = implement(organizationsContract).$context<BaseContext>();
const authed = os.use(withAuth);
function primaryDb(context: BaseContext) {
	return context.env.DB ? createDbClient(context.env.DB) : context.db;
}
async function owner(context: BaseContext) {
	const organizationId = requireOrgId(context);
	if (context.authType !== "user" || !context.user?.sub)
		throw new ORPCError("FORBIDDEN", {
			message: "An organization owner or administrator is required",
		});
	const member = context.userId
		? await getMemberByCanonicalUserId(
				primaryDb(context),
				organizationId,
				context.userId,
			)
		: await getMemberByUserId(
				primaryDb(context),
				organizationId,
				context.user.sub,
			);
	if (member?.status !== "active" || !["owner", "admin"].includes(member.role))
		throw new ORPCError("FORBIDDEN", {
			message: "An active organization owner or administrator is required",
		});
	return organizationId;
}
function providerEnv(context: BaseContext) {
	try {
		return organizationHostnameProvider(
			context.env as OrganizationCustomHostnameEnv,
		);
	} catch {
		throw new ORPCError("BAD_GATEWAY", {
			message:
				"Organization custom domains are not configured for this installation",
		});
	}
}
type Claim = NonNullable<Awaited<ReturnType<typeof getOrganizationDomain>>>;
function status(claim: Claim, provider?: CmsCustomHostname | null) {
	const validationRecords: Array<{
		type: "TXT" | "CNAME";
		name: string;
		value: string;
	}> = [];
	if (
		provider?.ownership_verification?.name &&
		provider.ownership_verification.value
	)
		validationRecords.push({
			type: "TXT",
			name: provider.ownership_verification.name,
			value: provider.ownership_verification.value,
		});
	for (const record of provider?.ssl?.validation_records ?? []) {
		if (record.txt_name && record.txt_value)
			validationRecords.push({
				type: "TXT",
				name: record.txt_name,
				value: record.txt_value,
			});
		else if (record.cname && record.cname_target)
			validationRecords.push({
				type: "CNAME",
				name: record.cname,
				value: record.cname_target,
			});
	}
	return {
		claimId: claim.id,
		hostname: claim.hostname,
		status: claim.status as "pending" | "provisioning" | "active" | "removing",
		txtName: organizationDomainVerificationName(claim.hostname),
		txtValue: claim.verificationToken,
		cnameTarget: "os.tedix.dev",
		expiresAt: claim.expiresAt,
		validationRecords,
	};
}
function assertProvider(claim: Claim, provider: CmsCustomHostname) {
	if (
		provider.hostname.toLowerCase() !== claim.hostname ||
		(claim.providerHostnameId !== null &&
			provider.id !== claim.providerHostnameId)
	)
		throw new ORPCError("CONFLICT", {
			message: "Provider hostname belongs to another claim",
		});
}
export const getCustomDomain = authed.getCustomDomain
	.use(AUTHZ.settingsRead)
	.handler(async ({ context }) => {
		const organizationId = await owner(context);
		const claim = await getOrganizationDomain(
			primaryDb(context),
			organizationId,
		);
		if (!claim) return null;
		let provider: CmsCustomHostname | null = null;
		if (claim.providerHostnameId) {
			try {
				provider = await getCmsCustomHostname(
					providerEnv(context),
					claim.providerHostnameId,
				);
			} catch {
				// Keep removal available when the provider cannot be reached.
				return status(claim);
			}
		}
		if (provider) assertProvider(claim, provider);
		return status(claim, provider);
	});
export const beginCustomDomain = authed.beginCustomDomain
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = await owner(context);
		providerEnv(context);
		let hostname: string;
		try {
			hostname = assertCustomHostname(input.hostname.trim());
		} catch {
			throw new ORPCError("BAD_REQUEST", {
				message: "Enter a hostname such as share.example.com",
			});
		}
		const claim = await reserveOrganizationDomain(primaryDb(context), {
			id: crypto.randomUUID(),
			organizationId,
			hostname,
			verificationToken: createCmsDomainVerificationToken(),
			expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
		});
		if (!claim)
			throw new ORPCError("CONFLICT", {
				message:
					"Remove the existing domain first, or choose an available hostname. OS must be enabled for this organization.",
			});
		return status(claim);
	});
export const verifyCustomDomain = authed.verifyCustomDomain
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = await owner(context);
		const env = providerEnv(context);
		const db = primaryDb(context);
		const claim = await lockOrganizationDomain(
			db,
			organizationId,
			input.claimId,
			"provisioning",
		);
		if (!claim)
			throw new ORPCError("CONFLICT", {
				message: "Domain claim is missing, expired or busy. Reload Settings.",
			});
		let providerId = claim.providerHostnameId;
		let createRequested = false;
		let active = false;
		let provider: CmsCustomHostname | null = null;
		try {
			if (
				!(await verifyCmsDnsChallenge(
					claim.hostname,
					claim.verificationToken,
					organizationDomainVerificationName(claim.hostname),
				))
			)
				throw new ORPCError("BAD_REQUEST", {
					message:
						"TXT ownership record was not found. Check the record and try again.",
				});
			provider = providerId
				? await getCmsCustomHostname(env, providerId)
				: await findCmsCustomHostname(env, claim.hostname);
			if (providerId && !provider)
				throw new ORPCError("CONFLICT", {
					message:
						"Provider hostname is missing. Remove this domain and add it again.",
				});
			if (provider) assertProvider(claim, provider);
			else {
				createRequested = true;
				provider = await createCmsCustomHostname(env, claim.hostname);
			}
			assertProvider(claim, provider);
			providerId = provider.id;
			active =
				claim.expiresAt > new Date().toISOString() &&
				isCmsCustomHostnameReady(provider) &&
				(await verifyCmsDnsTarget(claim.hostname, "os.tedix.dev", "os"));
		} catch (error) {
			// A timed-out create may have allocated a provider hostname. Keep the
			// reservation locked until a verified retry recovers its exact ID.
			if (createRequested && !providerId) throw error;
			await finishOrganizationDomainVerification(db, {
				organizationId,
				id: claim.id,
				lease: claim.updatedAt,
				status: "pending",
				providerHostnameId: providerId,
			});
			throw error;
		}
		const saved = await finishOrganizationDomainVerification(db, {
			organizationId,
			id: claim.id,
			lease: claim.updatedAt,
			status: active ? "active" : "pending",
			providerHostnameId: providerId,
		});
		if (!saved)
			throw new ORPCError("CONFLICT", {
				message: "Domain changed during verification. Reload Settings.",
			});
		return status(saved, provider);
	});
export const removeCustomDomain = authed.removeCustomDomain
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		const organizationId = await owner(context);
		const db = primaryDb(context);
		const claim = await lockOrganizationDomain(
			db,
			organizationId,
			input.claimId,
			"removing",
		);
		if (!claim)
			throw new ORPCError("CONFLICT", {
				message:
					"Domain claim is missing or verification is running. Reload Settings.",
			});
		const env = claim.providerHostnameId ? providerEnv(context) : null;
		const provider =
			claim.providerHostnameId && env
				? await getCmsCustomHostname(env, claim.providerHostnameId)
				: null;
		if (provider && env) {
			assertProvider(claim, provider);
			await deleteCmsCustomHostname(env, provider.id, claim.hostname);
		}
		if (!(await deleteOrganizationDomain(db, organizationId, claim.id)))
			throw new ORPCError("CONFLICT", {
				message: "Domain changed during removal",
			});
		return { success: true };
	});
