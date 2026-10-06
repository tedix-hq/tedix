import assert from "node:assert/strict";
import {
	assertPortableCallable,
	bindEmbeddedPortableTenantArgs,
	embeddedPortableArgs,
	executeEmbeddedPortableCall,
	projectEmbeddedCustomerWorkResult,
} from "./embedded-portable-tool";

const authority = {
	hostTenantNamespace: "acme_staging",
	allowedCallables: ["acme_staging.get_order", "work.list_work_items"],
};

assert.doesNotThrow(() =>
	assertPortableCallable("acme_staging.get_order", authority),
);
assert.doesNotThrow(() =>
	assertPortableCallable("work.list_work_items", authority),
);
assert.throws(
	() => assertPortableCallable("other.get_order", authority),
	/not admitted/,
);

assert.deepEqual(
	embeddedPortableArgs(
		"work.add_comment",
		{ id: "work-1", body: "Verified", metadata: { embeddedActor: "forged" } },
		{
			hostOrganizationId: "acme-org",
			hostUserId: "user-1",
			hostUserLabel: "Owner",
			hostRole: "owner",
		},
	),
	{
		id: "work-1",
		body: "Verified",
		metadata: {
			embeddedActor: {
				hostOrganizationId: "acme-org",
				hostUserId: "user-1",
				hostUserLabel: "Owner",
				hostRole: "owner",
			},
		},
	},
);
assert.throws(
	() =>
		embeddedPortableArgs(
			"work.add_comment",
			{ id: "work-1", body: "forged" },
			{
				hostOrganizationId: "acme-org",
				hostUserId: "user-2",
				hostRole: "viewer",
			},
		),
	/not allowed/,
);
assert.throws(
	() => assertPortableCallable("acme_staging.delete_order", authority),
	/not admitted/,
);

const tenantAuthority = {
	hostTenantNamespace: "acme_staging",
	hostTenantArgument: "companyId",
	hostOrganizationId: "signed-company",
};
assert.deepEqual(
	bindEmbeddedPortableTenantArgs(
		"acme_staging.get_order",
		{ orderId: "42", companyId: "attacker-company" },
		tenantAuthority,
	),
	{ orderId: "42", companyId: "signed-company" },
);
assert.deepEqual(
	bindEmbeddedPortableTenantArgs(
		"acme_staging.get_order",
		{ orderId: "42" },
		tenantAuthority,
	),
	{ orderId: "42", companyId: "signed-company" },
);
assert.deepEqual(
	bindEmbeddedPortableTenantArgs(
		"organizations.get_features",
		{ organizationId: "attacker-org" },
		{
			hostTenantNamespace: "organizations",
			hostTenantArgument: "organizationId",
			hostOrganizationId: "signed-org",
		},
	),
	{ organizationId: "signed-org" },
);
assert.deepEqual(
	bindEmbeddedPortableTenantArgs(
		"work.list_work_items",
		{ limit: 2 },
		tenantAuthority,
	),
	{ limit: 2 },
);
assert.deepEqual(
	bindEmbeddedPortableTenantArgs(
		"acme_staging_extra.get_order",
		{ orderId: "42" },
		tenantAuthority,
	),
	{ orderId: "42" },
);

const workRows = {
	data: [
		{
			id: "customer-work",
			title: "Prepare customer delivery",
			description: "Visible business work",
			disposition: "accepted",
			metadata: {
				customerVisible: true,
				hostDeepLink: "/m/orders/42",
				agentSession: "must-not-leak",
			},
			provenance: { source: "private-source" },
			sourceSessionKey: "private-session",
		},
		{
			id: "delegation",
			title: "Internal delegation",
			provenance: { source: "kernelRuntime.directDelegation" },
		},
		{
			id: "other-tenant-shaped-secret",
			title: "Private agent execution",
			metadata: { customerVisible: false, secret: "never-return" },
		},
	],
};
const projected = projectEmbeddedCustomerWorkResult({
	content: [{ type: "text", text: JSON.stringify(workRows) }],
});
assert.deepEqual(
	projected.data.map((item) => item.id),
	["customer-work"],
);
assert.equal(projected.data[0]?.metadata.hostDeepLink, "/m/orders/42");
assert.doesNotMatch(
	JSON.stringify(projected),
	/private-source|private-session|must-not-leak|never-return/,
);

const calls: Array<{ callable: string; args: Record<string, unknown> }> = [];
const execute = async (callable: string, args: Record<string, unknown>) => {
	calls.push({ callable, args });
	if (callable === "work.list_work_items") {
		const id = typeof args.idPrefix === "string" ? args.idPrefix : undefined;
		const rows = id
			? workRows.data.filter((item) => item.id === id)
			: workRows.data;
		const offset = Number(args.offset) || 0;
		const limit = Number(args.limit) || rows.length;
		return { data: rows.slice(offset, offset + limit) };
	}
	return { changed: true };
};
const embeddedAuthority = {
	hostOrganizationId: "acme-org",
	hostUserId: "user-1",
	hostRole: "owner",
	allowedCallables: [
		"work.list_work_items",
		"work.list_work_item_events",
		"work.add_comment",
	],
};

assert.deepEqual(
	await executeEmbeddedPortableCall({
		callable: "work.list_work_items",
		args: {
			disposition: "accepted",
			limit: 2,
			organizationId: "attacker-selected-org",
		},
		authority: embeddedAuthority,
		execute,
	}),
	{
		data: [projected.data[0]],
		pagination: { total: 1, hasMore: false },
	},
);
assert.equal(
	calls.some(({ args }) => "organizationId" in args || "orgId" in args),
	false,
);

const hiddenPrefix = Array.from({ length: 25 }, (_, index) => ({
	id: `internal-${index}`,
	title: `Internal ${index}`,
	metadata: { customerVisible: false },
}));
const pagedRows = [...hiddenPrefix, workRows.data[0]];
const pagedExecute = async (
	_callable: string,
	args: Record<string, unknown>,
) => {
	const offset = Number(args.offset) || 0;
	const limit = Number(args.limit) || pagedRows.length;
	return { data: pagedRows.slice(offset, offset + limit) };
};
assert.deepEqual(
	await executeEmbeddedPortableCall({
		callable: "work.list_work_items",
		args: { limit: 1 },
		authority: embeddedAuthority,
		execute: pagedExecute,
	}),
	{
		data: [projected.data[0]],
		pagination: { total: 1, hasMore: false },
	},
);

assert.deepEqual(
	await executeEmbeddedPortableCall({
		callable: "work.list_work_item_events",
		args: { id: "customer-work" },
		authority: embeddedAuthority,
		execute,
	}),
	{ data: [projected.data[0]], pagination: { total: 1, hasMore: false } },
);
await assert.rejects(
	executeEmbeddedPortableCall({
		callable: "work.add_comment",
		args: { id: "delegation", body: "Do not publish" },
		authority: embeddedAuthority,
		execute,
	}),
	/not customer-visible/,
);
await executeEmbeddedPortableCall({
	callable: "work.add_comment",
	args: { id: "customer-work", body: "Published" },
	authority: embeddedAuthority,
	execute,
});
assert.deepEqual(calls.at(-1), {
	callable: "work.add_comment",
	args: {
		id: "customer-work",
		body: "Published",
		metadata: {
			embeddedActor: {
				hostOrganizationId: "acme-org",
				hostUserId: "user-1",
				hostUserLabel: null,
				hostRole: "owner",
			},
		},
	},
});

console.log("embedded portable WebMCP callable admission passed");
