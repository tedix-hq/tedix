import * as z from "zod";

export const ORGANIZATION_DOMAIN_ENTRY = "tedix:app/organization-domain";
export const OrganizationDomainBeginSchema = z.object({
	hostname: z.string().trim().min(4).max(253),
});
export const OrganizationDomainKeySchema = z.object({
	claimId: z.string().uuid(),
});
export const OrganizationDomainSchema = z.object({
	claimId: z.string(),
	hostname: z.string(),
	status: z.enum(["pending", "provisioning", "active", "removing"]),
	txtName: z.string(),
	txtValue: z.string(),
	cnameTarget: z.string(),
	expiresAt: z.string(),
	validationRecords: z.array(
		z.object({
			type: z.enum(["TXT", "CNAME"]),
			name: z.string(),
			value: z.string(),
		}),
	),
});
