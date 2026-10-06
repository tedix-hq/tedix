import { createRouterClient, ORPCError } from "@orpc/server";
import {
	activateProviderCustomerBilling,
	getBillingEntitlement,
	requireActiveBillingPlan,
} from "@tedix/db/queries/billing/plans";
import { getOrganizationByDescopeId } from "@tedix/db/queries/organizations";
import {
	createOsWorkspace,
	getOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediBySlug } from "@tedix/db/queries/tedis";
import type { BaseContext } from "../rpc/orpc";
import { ensureProviderWorkerReady } from "./provider-worker-readiness";

export interface ProviderCustomerConfiguration {
	name: string;
	billingPlanKey: "growth" | "business" | "enterprise";
	ownerUserId?: string;
	ownerEmail?: string;
	language?: string;
	timezone?: string;
	personality?: string;
}

/** Stable resource names let a retried operation resume without a second tenant. */
export async function providerCustomerKey(
	providerOrganizationId: string,
	providerAppId: string,
	externalTenantId: string,
): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([providerOrganizationId, providerAppId, externalTenantId]),
		),
	);
	return Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	)
		.join("")
		.slice(0, 32);
}

async function ensureCustomerResources(
	context: BaseContext,
	input: {
		providerOrganizationId: string;
		providerAppId: string;
		externalTenantId: string;
		customer: ProviderCustomerConfiguration;
	},
	providerAuthorized = false,
) {
	const key = await providerCustomerKey(
		input.providerOrganizationId,
		input.providerAppId,
		input.externalTenantId,
	);
	// The organization's handle is NOT derived here. It comes from the customer
	// name through canonical provisioning, so the customer reads a legible
	// `{handle}.os.tedix.dev`, not a 32-hex digest. `key` stays the identity: it
	// is the idempotency key and the Descope tenant id, neither of which moves
	// when the handle is corrected later.
	const descopeTenantId = `org_${key}`;
	const now = new Date().toISOString();
	const plan = await requireActiveBillingPlan(
		context.db,
		input.customer.billingPlanKey,
		now,
	);
	if (!plan.allowOverage)
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Automatic customer provisioning requires a non-trial plan allowing sponsored overflow",
		});
	// Reuse canonical organization and worker provisioning, including identity and secrets.
	// These large routers stay lazy and are loaded only on an actual onboarding request.
	const { createOrganizationContract, createOrganizationForProvider } =
		await import("../rpc/routers/organizations");
	const {
		createTediProcedure,
		createTediForProvider,
		materializeManagedAppAssignments,
	} = await import("../rpc/routers/tedis/crud");
	const guardedClient = createRouterClient(
		{ organization: createOrganizationContract, tedi: createTediProcedure },
		{ context },
	);
	const client = providerAuthorized
		? {
				organization: (
					value: Parameters<typeof createOrganizationForProvider>[1],
				) => createOrganizationForProvider(context, value),
				tedi: (value: Parameters<typeof createTediForProvider>[1]) =>
					createTediForProvider(context, value),
			}
		: guardedClient;
	// Re-enter canonical provisioning even when its row exists: principal binding
	// and owner membership happen after the atomic organization/billing insert.
	await client.organization({
		name: input.customer.name,
		ownerUserId: input.customer.ownerUserId,
		ownerEmail: input.customer.ownerEmail,
		metadata: { providerCustomerKey: key },
	});
	const organization = await getOrganizationByDescopeId(
		context.db,
		descopeTenantId,
	);
	if (!organization || organization.metadata?.providerCustomerKey !== key)
		throw new ORPCError("CONFLICT", {
			message: "Customer resource ownership could not be verified",
		});
	// Every later resource follows the organization's persisted handle, so a
	// retry reuses whatever handle the first pass settled on.
	const slug = organization.slug;
	const entitlement = await getBillingEntitlement(context.db, organization.id);
	if (!entitlement)
		throw new ORPCError("CONFLICT", {
			message: "Customer billing account is missing",
		});
	if (
		entitlement.account.status === "trial" &&
		entitlement.account.billingMode === "trial"
	) {
		await activateProviderCustomerBilling(context.db, {
			organizationId: organization.id,
			planVersionId: plan.id,
			entitlementVersion: entitlement.account.entitlementVersion,
			now,
			metadata: {
				...entitlement.account.metadata,
				providerCustomerKey: key,
				providerOrganizationId: input.providerOrganizationId,
			},
		});
	}
	const configured = await getBillingEntitlement(context.db, organization.id);
	if (
		!configured ||
		configured.account.status !== "active" ||
		configured.account.billingMode !== "internal" ||
		configured.plan.id !== plan.id
	) {
		throw new ORPCError("CONFLICT", {
			message:
				"Customer billing has changed; automatic provisioning will not overwrite it",
		});
	}
	const workspaceId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20)}`;
	let workspace = await getOsWorkspace(context.db, {
		organizationId: organization.id,
		workspaceId,
	});
	if (!workspace) {
		try {
			workspace = await createOsWorkspace(context.db, {
				id: workspaceId,
				organizationId: organization.id,
				name: input.customer.name,
				createdByKind: "service",
				createdById: input.providerOrganizationId,
			});
		} catch (error) {
			workspace = await getOsWorkspace(context.db, {
				organizationId: organization.id,
				workspaceId,
			});
			if (!workspace) throw error;
		}
	}
	if (workspace.status !== "active")
		throw new ORPCError("CONFLICT", {
			message: "Customer workspace is archived",
		});
	let tedi = await getTediBySlug(context.db, organization.id, slug);
	if (!tedi) {
		try {
			await client.tedi({
				organizationId: organization.id,
				name: input.customer.name,
				slug,
				language: input.customer.language,
				timezone: input.customer.timezone,
				personality: input.customer.personality,
				registerDescopeAih: false,
			});
		} catch (error) {
			if (!(await getTediBySlug(context.db, organization.id, slug)))
				throw error;
		}
		tedi = await getTediBySlug(context.db, organization.id, slug);
	}
	if (!tedi || !organization.descopeTenantId)
		throw new ORPCError("CONFLICT", {
			message: "Customer worker identity is not ready",
		});
	const readyTedi = await ensureProviderWorkerReady(context, {
		organizationId: organization.id,
		tenantId: organization.descopeTenantId,
		tediId: tedi.id,
		slug,
	});
	await materializeManagedAppAssignments(context, readyTedi);
	return {
		customerOrganizationId: organization.id,
		primaryWorkspaceId: workspace.id,
		primaryTediId: tedi.id,
	};
}

export function ensureProviderCustomer(
	context: BaseContext,
	input: Parameters<typeof ensureCustomerResources>[1],
) {
	return ensureCustomerResources(context, input);
}

/** Called only after the provider route loads protected onboarding defaults. */
export function ensureProviderCustomerForProvider(
	context: BaseContext,
	input: Parameters<typeof ensureCustomerResources>[1],
) {
	if (
		context.organizationId !== input.providerOrganizationId ||
		!input.customer.ownerUserId ||
		!input.customer.ownerEmail
	)
		throw new ORPCError("FORBIDDEN", {
			message: "Provider scope and configured owner are required",
		});
	return ensureCustomerResources(context, input, true);
}
