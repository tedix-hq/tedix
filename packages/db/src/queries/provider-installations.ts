import { providerWidgetAllowsTedi } from "@tedix/api-contract/schemas/embedded-widget-access";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import {
	readEmbeddedWidgetAccess,
	type EmbeddedWidgetAccessPolicy,
} from "@tedix/api-contract/schemas/embedded-widget-access";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	providerInstallations,
	type NewProviderInstallation,
	type ProviderInstallation,
} from "../schema/provider-installations";

export interface ProviderCapacitySponsorship {
	installationId: string;
	providerAppId: string;
	externalTenantId: string;
	customerOrganizationId: string;
	policy: {
		enabled: boolean;
		budgetRevision: number;
		maxTransfersPerBudgetDay: number;
		lowWatermarkTokens: number;
		lowWatermarkSpendMicros: number;
		transferTokens: number;
		transferSpendMicros: number;
	} | null;
}

export interface PortableWebMcpProfileRevision {
	revision: number;
	profile: PortableWebMcpProfile;
	changeSummary: string;
	publishedAt: string;
	publishedBy: string;
}

export interface ProviderPortableWebMcpConfiguration {
	installationId: string;
	providerAppId: string;
	externalTenantId: string;
	hostTenantNamespace: string;
	hostTenantArgument: string;
	revision: number;
	profile: PortableWebMcpProfile | null;
	history: PortableWebMcpProfileRevision[];
}

function readPortableWebMcpConfiguration(
	installation: ProviderInstallation,
): ProviderPortableWebMcpConfiguration {
	const raw = installation.provenance?.portableWebMcp;
	const value =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, JsonValue>)
			: null;
	const revision =
		value && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
			? Number(value.revision)
			: 0;
	const profile =
		value?.profile && typeof value.profile === "object"
			? (value.profile as PortableWebMcpProfile)
			: null;
	const history = Array.isArray(value?.history)
		? (value.history as unknown as PortableWebMcpProfileRevision[]).filter(
				(entry) =>
					Number.isSafeInteger(entry.revision) &&
					entry.revision > 0 &&
					Boolean(entry.profile),
			)
		: [];
	return {
		installationId: installation.id,
		providerAppId: installation.providerAppId,
		externalTenantId: installation.externalTenantId,
		hostTenantNamespace: installation.hostTenantNamespace,
		hostTenantArgument: installation.hostTenantArgument,
		revision,
		profile,
		history,
	};
}

export async function listProviderPortableWebMcpConfigurations(
	db: DbClient,
	providerOrganizationId: string,
): Promise<ProviderPortableWebMcpConfiguration[]> {
	const rows = await db
		.select()
		.from(providerInstallations)
		.where(
			eq(providerInstallations.providerOrganizationId, providerOrganizationId),
		)
		.orderBy(desc(providerInstallations.updatedAt));
	return rows.map(readPortableWebMcpConfiguration);
}

export async function publishProviderPortableWebMcpProfile(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		installationId: string;
		expectedRevision: number;
		profile: PortableWebMcpProfile;
		changeSummary: string;
		publishedBy: string;
	},
): Promise<ProviderPortableWebMcpConfiguration | null | "conflict"> {
	const existing = await getProviderInstallationById(db, {
		organizationId: input.providerOrganizationId,
		installationId: input.installationId,
	});
	if (!existing) return null;
	const current = readPortableWebMcpConfiguration(existing);
	if (current.revision !== input.expectedRevision) return "conflict";
	const now = new Date().toISOString();
	const nextRevision: PortableWebMcpProfileRevision = {
		revision: current.revision + 1,
		profile: input.profile,
		changeSummary: input.changeSummary,
		publishedAt: now,
		publishedBy: input.publishedBy,
	};
	const provenance = {
		...(existing.provenance ?? {}),
		portableWebMcp: {
			revision: nextRevision.revision,
			profile: input.profile,
			history: [...current.history, nextRevision].slice(-20),
		},
	} as unknown as Record<string, JsonValue>;
	const [updated] = await db
		.update(providerInstallations)
		.set({ provenance, updatedAt: now })
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(
					providerInstallations.providerOrganizationId,
					input.providerOrganizationId,
				),
				eq(providerInstallations.updatedAt, existing.updatedAt),
			),
		)
		.returning();
	return updated ? readPortableWebMcpConfiguration(updated) : "conflict";
}

function readCapacityPolicy(provenance: Record<string, JsonValue> | null) {
	const raw = provenance?.sponsoredCapacity;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const value = raw as Record<string, JsonValue>;
	const budgetRevision = value.budgetRevision ?? 1;
	const maxTransfersPerBudgetDay = value.maxTransfersPerBudgetDay ?? 1;
	const numbers = [
		budgetRevision,
		maxTransfersPerBudgetDay,
		value.lowWatermarkTokens,
		value.lowWatermarkSpendMicros,
		value.transferTokens,
		value.transferSpendMicros,
	];
	if (
		!numbers.every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0)
	)
		return null;
	return {
		enabled: value.enabled === true,
		budgetRevision: Number(budgetRevision),
		maxTransfersPerBudgetDay: Number(maxTransfersPerBudgetDay),
		lowWatermarkTokens: Number(value.lowWatermarkTokens),
		lowWatermarkSpendMicros: Number(value.lowWatermarkSpendMicros),
		transferTokens: Number(value.transferTokens),
		transferSpendMicros: Number(value.transferSpendMicros),
	};
}

export async function listProviderCapacitySponsorships(
	db: DbClient,
	providerOrganizationId: string,
): Promise<ProviderCapacitySponsorship[]> {
	const rows = await db
		.select()
		.from(providerInstallations)
		.where(
			eq(providerInstallations.providerOrganizationId, providerOrganizationId),
		);
	return rows.map((row) => ({
		installationId: row.id,
		providerAppId: row.providerAppId,
		externalTenantId: row.externalTenantId,
		customerOrganizationId: row.customerOrganizationId,
		policy: readCapacityPolicy(row.provenance),
	}));
}

export async function setProviderCapacitySponsorship(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		installationId: string;
		policy: NonNullable<ProviderCapacitySponsorship["policy"]>;
	},
): Promise<ProviderCapacitySponsorship | null> {
	const existing = await getProviderInstallationById(db, {
		organizationId: input.providerOrganizationId,
		installationId: input.installationId,
	});
	if (!existing) return null;
	const provenance = {
		...(existing.provenance ?? {}),
		sponsoredCapacity: input.policy,
	};
	const [updated] = await db
		.update(providerInstallations)
		.set({ provenance, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(
					providerInstallations.providerOrganizationId,
					input.providerOrganizationId,
				),
			),
		)
		.returning();
	if (!updated) return null;
	return {
		installationId: updated.id,
		providerAppId: updated.providerAppId,
		externalTenantId: updated.externalTenantId,
		customerOrganizationId: updated.customerOrganizationId,
		policy: readCapacityPolicy(updated.provenance),
	};
}

export async function provisionProviderInstallation(
	db: DbClient,
	input: NewProviderInstallation,
): Promise<ProviderInstallation> {
	const now = new Date().toISOString();
	const [row] = await db
		.insert(providerInstallations)
		.values({ ...input, updatedAt: now })
		.onConflictDoUpdate({
			target: [
				providerInstallations.providerOrganizationId,
				providerInstallations.providerAppId,
				providerInstallations.externalTenantId,
			],
			set: {
				providerApiKeyId: input.providerApiKeyId,
				customerOrganizationId: input.customerOrganizationId,
				primaryWorkspaceId: input.primaryWorkspaceId,
				primaryTediId: input.primaryTediId,
				allowedOrigin: input.allowedOrigin,
				hostTenantArgument: input.hostTenantArgument,
				hostTenantNamespace: input.hostTenantNamespace,
				status: "active",
				provisionedBy: input.provisionedBy,
				provenance: input.provenance,
				updatedAt: now,
				pausedAt: null,
			},
		})
		.returning();
	if (!row) throw new Error("Provider installation upsert returned no row");
	return row;
}

export async function getProviderInstallation(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		providerAppId: string;
		externalTenantId: string;
	},
): Promise<ProviderInstallation | undefined> {
	const [row] = await db
		.select()
		.from(providerInstallations)
		.where(
			and(
				eq(
					providerInstallations.providerOrganizationId,
					input.providerOrganizationId,
				),
				eq(providerInstallations.providerAppId, input.providerAppId),
				eq(providerInstallations.externalTenantId, input.externalTenantId),
			),
		)
		.limit(1);
	return row;
}

export async function getProviderInstallationById(
	db: DbClient,
	input: { organizationId: string; installationId: string },
): Promise<ProviderInstallation | undefined> {
	const [row] = await db
		.select()
		.from(providerInstallations)
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(providerInstallations.providerOrganizationId, input.organizationId),
			),
		)
		.limit(1);
	return row;
}

export async function resolveActiveProviderInstallation(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		providerApiKeyId: string;
		externalTenantId: string;
	},
): Promise<ProviderInstallation | undefined> {
	const [row] = await db
		.select()
		.from(providerInstallations)
		.where(
			and(
				eq(
					providerInstallations.providerOrganizationId,
					input.providerOrganizationId,
				),
				eq(providerInstallations.providerApiKeyId, input.providerApiKeyId),
				eq(providerInstallations.externalTenantId, input.externalTenantId),
				eq(providerInstallations.status, "active"),
			),
		)
		.limit(1);
	return row;
}

/** Resolve the exact signed embedded authority used for outcome attribution. */
export async function resolveActiveProviderInstallationForOutcome(
	db: DbClient,
	input: {
		installationId: string;
		providerAppId: string;
		customerOrganizationId: string;
		primaryTediId: string;
		externalTenantId: string;
		allowedOrigin: string;
	},
): Promise<ProviderInstallation | undefined> {
	const [row] = await db
		.select()
		.from(providerInstallations)
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(providerInstallations.providerAppId, input.providerAppId),
				eq(
					providerInstallations.customerOrganizationId,
					input.customerOrganizationId,
				),
				eq(providerInstallations.externalTenantId, input.externalTenantId),
				eq(providerInstallations.allowedOrigin, input.allowedOrigin),
				eq(providerInstallations.status, "active"),
			),
		)
		.limit(1);
	return row && providerWidgetAllowsTedi(row, input.primaryTediId)
		? row
		: undefined;
}

export async function setProviderInstallationPaused(
	db: DbClient,
	input: {
		organizationId: string;
		installationId: string;
		paused: boolean;
	},
): Promise<ProviderInstallation | undefined> {
	const now = new Date().toISOString();
	const [row] = await db
		.update(providerInstallations)
		.set({
			status: input.paused ? "paused" : "active",
			pausedAt: input.paused ? now : null,
			updatedAt: now,
		})
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(providerInstallations.providerOrganizationId, input.organizationId),
			),
		)
		.returning();
	return row;
}

export async function listProviderWidgetInstallations(
	db: DbClient,
	organizationId: string,
) {
	return db
		.select()
		.from(providerInstallations)
		.where(eq(providerInstallations.providerOrganizationId, organizationId))
		.orderBy(desc(providerInstallations.updatedAt));
}

export async function updateProviderWidgetAccess(
	db: DbClient,
	input: {
		organizationId: string;
		installationId: string;
		expectedRevision: number;
		policy: EmbeddedWidgetAccessPolicy;
		updatedBy: string;
	},
): Promise<ProviderInstallation | null | "conflict"> {
	const row = await getProviderInstallationById(db, input);
	if (!row) return null;
	const current = readEmbeddedWidgetAccess(row.provenance);
	if (current.revision !== input.expectedRevision) return "conflict";
	const now = new Date().toISOString();
	const next = {
		revision: current.revision + 1,
		policy: input.policy,
		updatedAt: now,
		updatedBy: input.updatedBy,
	};
	const rawHistory = row.provenance?.widgetAccessHistory;
	const history = Array.isArray(rawHistory) ? rawHistory : [];
	const provenance = {
		...row.provenance,
		widgetAccess: next,
		widgetAccessHistory: [...history, next].slice(-20),
	} as Record<string, JsonValue>;
	const [updated] = await db
		.update(providerInstallations)
		.set({ provenance, updatedAt: now })
		.where(
			and(
				eq(providerInstallations.id, input.installationId),
				eq(providerInstallations.providerOrganizationId, input.organizationId),
				row.provenance === null
					? isNull(providerInstallations.provenance)
					: eq(providerInstallations.provenance, row.provenance),
				eq(providerInstallations.updatedAt, row.updatedAt),
			),
		)
		.returning();
	return updated ?? "conflict";
}

/** Automatic onboarding must never reactivate or overwrite an existing installation. */
export async function createProviderInstallationIfAbsent(
	db: DbClient,
	input: NewProviderInstallation,
): Promise<ProviderInstallation> {
	await db
		.insert(providerInstallations)
		.values(input)
		.onConflictDoNothing({
			target: [
				providerInstallations.providerOrganizationId,
				providerInstallations.providerAppId,
				providerInstallations.externalTenantId,
			],
		});
	const row = await getProviderInstallation(db, input);
	if (!row) throw new Error("Provider installation insert returned no row");
	return row;
}
