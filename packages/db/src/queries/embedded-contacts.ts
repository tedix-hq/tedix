import { and, count, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import {
	EmbeddedContactAttributesSchema,
	type EmbeddedContactAttributes,
	type EmbeddedContactProfilePatch,
} from "@tedix/api-contract/schemas/embedded-contact";
import type { DbClient } from "../client";
import {
	embeddedContactUsers as users,
	providerInstallations as installations,
} from "../schema/provider-installations";
import { organizations } from "../schema/organizations";

const userColumns = {
	installationId: users.installationId,
	externalTenantId: installations.externalTenantId,
	hostUserId: users.hostUserId,
	name: users.name,
	email: users.email,
	role: users.role,
	customAttributes: users.customAttributes,
	firstSeenAt: users.firstSeenAt,
	lastSeenAt: users.lastSeenAt,
};
const companyColumns = {
	installationId: installations.id,
	externalTenantId: installations.externalTenantId,
	companyProfile: installations.companyProfile,
	fallbackName: organizations.name,
};
const companyName = sql<
	string | null
>`CASE WHEN ${installations.companyProfile} IS NULL THEN ${organizations.name} ELSE json_extract(${installations.companyProfile}, '$.name') END`;
function searchLike(value: string) {
	return `%${value.replace(/[!%_]/g, "!$&")}%`;
}
function contains(column: SQL, search: string) {
	return sql`${column} LIKE ${searchLike(search)} ESCAPE '!'`;
}

export async function resolveProviderContactInstallation(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		providerApiKeyId: string;
		externalTenantId: string;
	},
) {
	const [row] = await db
		.select()
		.from(installations)
		.where(
			and(
				eq(installations.providerOrganizationId, input.providerOrganizationId),
				eq(installations.providerApiKeyId, input.providerApiKeyId),
				eq(installations.externalTenantId, input.externalTenantId),
			),
		)
		.limit(1);
	return row;
}
export async function getEmbeddedContactCompany(
	db: DbClient,
	providerOrganizationId: string,
	installationId: string,
) {
	const [row] = await db
		.select(companyColumns)
		.from(installations)
		.innerJoin(
			organizations,
			eq(organizations.id, installations.customerOrganizationId),
		)
		.where(
			and(
				eq(installations.providerOrganizationId, providerOrganizationId),
				eq(installations.id, installationId),
			),
		)
		.limit(1);
	return row;
}
export async function getEmbeddedContactUser(
	db: DbClient,
	providerOrganizationId: string,
	installationId: string,
	hostUserId: string,
) {
	const [row] = await db
		.select(userColumns)
		.from(users)
		.innerJoin(installations, eq(installations.id, users.installationId))
		.where(
			and(
				eq(installations.providerOrganizationId, providerOrganizationId),
				eq(users.installationId, installationId),
				eq(users.hostUserId, hostUserId),
			),
		)
		.limit(1);
	return row;
}
function mergeAttributes(
	current: EmbeddedContactAttributes,
	patch: EmbeddedContactAttributes | null | undefined,
) {
	if (patch === undefined) return current;
	if (patch === null) return {};
	const next = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return EmbeddedContactAttributesSchema.parse(next);
}
/** CAS retries preserve simultaneous sparse updates; profile fields never alter installation authority. */
export async function identifyEmbeddedContact(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		installationId: string;
		hostUserId: string;
		hostRole?: string | null;
		profile: EmbeddedContactProfilePatch;
		now: string;
	},
) {
	if (input.profile.company !== undefined) {
		let saved = false;
		for (let attempt = 0; attempt < 3 && !saved; attempt++) {
			const existing = await getEmbeddedContactCompany(
				db,
				input.providerOrganizationId,
				input.installationId,
			);
			if (!existing) throw new Error("Provider installation not found");
			const current = existing.companyProfile;
			const patch = input.profile.company;
			const next = {
				name:
					patch.name === undefined
						? current
							? current.name
							: existing.fallbackName
						: patch.name,
				customAttributes: mergeAttributes(
					current?.customAttributes ?? {},
					patch.customAttributes,
				),
				firstSeenAt: current?.firstSeenAt ?? input.now,
				lastSeenAt: input.now,
				revision: (current?.revision ?? 0) + 1,
			};
			const rows = await db
				.update(installations)
				.set({ companyProfile: next })
				.where(
					and(
						eq(installations.id, input.installationId),
						eq(
							installations.providerOrganizationId,
							input.providerOrganizationId,
						),
						current
							? sql`json_extract(${installations.companyProfile}, '$.revision') = ${current.revision}`
							: isNull(installations.companyProfile),
					),
				)
				.returning({ id: installations.id });
			saved = rows.length > 0;
		}
		if (!saved)
			throw new Error(
				"Contact profile changed concurrently; retry identification",
			);
	}
	let saved = false;
	for (let attempt = 0; attempt < 3 && !saved; attempt++) {
		const [current] = await db
			.select()
			.from(users)
			.where(
				and(
					eq(users.installationId, input.installationId),
					eq(users.hostUserId, input.hostUserId),
				),
			)
			.limit(1);
		const company = await getEmbeddedContactCompany(
			db,
			input.providerOrganizationId,
			input.installationId,
		);
		if (!company) throw new Error("Provider installation not found");
		const patch = input.profile.user ?? {};
		const next = {
			installationId: input.installationId,
			hostUserId: input.hostUserId,
			name: patch.name === undefined ? (current?.name ?? null) : patch.name,
			email: patch.email === undefined ? (current?.email ?? null) : patch.email,
			role:
				input.hostRole === undefined ? (current?.role ?? null) : input.hostRole,
			customAttributes: mergeAttributes(
				current?.customAttributes ?? {},
				patch.customAttributes,
			),
			firstSeenAt: current?.firstSeenAt ?? input.now,
			lastSeenAt: input.now,
			revision: (current?.revision ?? 0) + 1,
		};
		const rows = current
			? await db
					.update(users)
					.set(next)
					.where(
						and(
							eq(users.installationId, input.installationId),
							eq(users.hostUserId, input.hostUserId),
							eq(users.revision, current.revision),
						),
					)
					.returning({ hostUserId: users.hostUserId })
			: await db
					.insert(users)
					.values(next)
					.onConflictDoNothing()
					.returning({ hostUserId: users.hostUserId });
		saved = rows.length > 0;
	}
	if (!saved)
		throw new Error(
			"Contact profile changed concurrently; retry identification",
		);
	return {
		user: await getEmbeddedContactUser(
			db,
			input.providerOrganizationId,
			input.installationId,
			input.hostUserId,
		),
		company: await getEmbeddedContactCompany(
			db,
			input.providerOrganizationId,
			input.installationId,
		),
	};
}
export async function listEmbeddedContacts(
	db: DbClient,
	input: {
		providerOrganizationId: string;
		kind: "people" | "companies";
		hostUserIds?: string[];
		search?: string;
		installationId?: string;
		offset: number;
		limit: number;
	},
) {
	const scope = and(
		eq(installations.providerOrganizationId, input.providerOrganizationId),
		input.installationId
			? eq(installations.id, input.installationId)
			: undefined,
	);
	if (input.kind === "people") {
		const filter = and(
			scope,
			input.hostUserIds
				? sql`${users.hostUserId} IN (SELECT value FROM json_each(${JSON.stringify(input.hostUserIds)}))`
				: undefined,
			input.search
				? or(
						contains(sql`${users.name}`, input.search),
						contains(sql`${users.email}`, input.search),
						contains(sql`${users.hostUserId}`, input.search),
					)
				: undefined,
		);
		const people = await db
			.select(userColumns)
			.from(users)
			.innerJoin(installations, eq(installations.id, users.installationId))
			.where(filter)
			.orderBy(users.installationId, users.hostUserId)
			.limit(input.limit)
			.offset(input.offset);
		const [total] = await db
			.select({ total: count() })
			.from(users)
			.innerJoin(installations, eq(installations.id, users.installationId))
			.where(filter);
		const ids = [...new Set(people.map((person) => person.installationId))];
		const companies = ids.length
			? await db
					.select(companyColumns)
					.from(installations)
					.innerJoin(
						organizations,
						eq(organizations.id, installations.customerOrganizationId),
					)
					.where(
						and(
							eq(
								installations.providerOrganizationId,
								input.providerOrganizationId,
							),
							sql`${installations.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
						),
					)
			: [];
		return { people, companies, total: total?.total ?? 0 };
	}
	const filter = and(
		scope,
		input.search
			? or(
					contains(companyName, input.search),
					contains(sql`${installations.externalTenantId}`, input.search),
				)
			: undefined,
	);
	const companies = await db
		.select(companyColumns)
		.from(installations)
		.innerJoin(
			organizations,
			eq(organizations.id, installations.customerOrganizationId),
		)
		.where(filter)
		.orderBy(installations.id)
		.limit(input.limit)
		.offset(input.offset);
	const [total] = await db
		.select({ total: count() })
		.from(installations)
		.innerJoin(
			organizations,
			eq(organizations.id, installations.customerOrganizationId),
		)
		.where(filter);
	return { people: [], companies, total: total?.total ?? 0 };
}
