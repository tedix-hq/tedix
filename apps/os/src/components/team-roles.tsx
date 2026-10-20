/**
 * Team › Roles
 *
 * Static roles and permissions reference content:
 *
 *  - `RolePermissionsMatrix` renders the CANONICAL model from `@tedix/auth/rbac`
 *    — the same `ROLE_PERMISSION_GRANTS` every API guard evaluates.
 *  - `CapabilityScopeReference` renders `CAPABILITY_SCOPE_METADATA` from
 *    `@tedix/mcp-shared`, which lives beside the `CAPABILITY_SCOPES` the MCP
 *    edge enforces, so the page cannot drift from the real model.
 *
 * Deliberately NOT ported: the Descope `TenantRoleManagement` admin widget
 * (embedding provider admin widgets in product surfaces is policy-forbidden)
 * and the platform-admin `DescopeRbacDrift`
 * diagnostic. Role ASSIGNMENT stays on the Members tab and is enforced through
 * the server-side member APIs, which synchronize identity-provider state.
 */

import type { MemberRole } from "@tedix/api-contract/schemas/organization";
import {
	ASSIGNABLE_ROLES,
	describeRolePermissions,
	PERMISSION_GROUPS,
	type PermissionGroup,
	ROLE_METADATA,
} from "@tedix/auth/rbac";
import {
	CAPABILITY_SCOPE_METADATA,
	CAPABILITY_SCOPES,
} from "@tedix/mcp-shared/auth/scopes";
import { Key, LockKey, ShieldCheck } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";

/**
 * The roles a tenant administrator may assign, in descending authority.
 * Sourced from the canonical model rather than restated here, so a role added
 * to Tedix cannot go missing from this page — and a platform role can never
 * appear on it: `ASSIGNABLE_ROLES` excludes `platform-admin`.
 */
export const CANONICAL_ROLE_ORDER: readonly MemberRole[] = ASSIGNABLE_ROLES;

const GROUP_LABELS: Record<PermissionGroup, string> = {
	apps: "Apps",
	tedis: "Digital workers",
	os: "OS",
	team: "Organization",
	billing: "Billing",
	platform: "Platform",
};

const ROLE_BADGE_VARIANTS = {
	owner: "default",
	admin: "secondary",
	member: "outline",
	viewer: "ghost",
} as const;

/** Human labels for everything a role actually grants, in render order. */

function PermissionBadges({ role }: { role: MemberRole }) {
	const described = describeRolePermissions(role);
	if (described.length === 0) {
		return (
			<Text role="label" tone="secondary">
				This role grants no permissions.
			</Text>
		);
	}
	return (
		<div className="space-y-2">
			{PERMISSION_GROUPS.map((group) => {
				const inGroup = described.filter((entry) => entry.group === group);
				if (inGroup.length === 0) return null;
				return (
					<div key={group}>
						<Text
							className="mb-1"
							role="caption"
							tone="secondary"
							weight="medium"
						>
							{GROUP_LABELS[group]}
						</Text>
						<div className="flex flex-wrap gap-2">
							{inGroup.map((entry) => (
								<Badge
									key={entry.permission}
									title={`${entry.permission} — ${entry.description}`}
									variant="outline"
								>
									{entry.label}
								</Badge>
							))}
						</div>
					</div>
				);
			})}
		</div>
	);
}

export function RolePermissionsMatrix() {
	return (
		<Table
			className="min-w-[920px]"
			scrollLabel="Organization role permissions"
			aria-label="Organization role permissions"
		>
			<TableHeader>
				<TableRow>
					<TableHead sticky="left" className="min-w-48">
						Role
					</TableHead>
					<TableHead className="min-w-44">Responsibility</TableHead>
					<TableHead className="min-w-96">Granted permissions</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{CANONICAL_ROLE_ORDER.map((role) => {
					const details = ROLE_METADATA[role];
					return (
						<TableRow key={role}>
							<TableCell sticky="left" className="whitespace-nowrap align-top">
								<div className="space-y-2">
									<Badge variant={ROLE_BADGE_VARIANTS[role]}>
										{details.label}
									</Badge>
									<Text
										className="max-w-64 whitespace-normal leading-relaxed"
										role="label"
										tone="secondary"
									>
										{details.description}
									</Text>
								</div>
							</TableCell>
							<TableCell className="whitespace-nowrap align-top text-kumo-default">
								{details.responsibility}
							</TableCell>
							<TableCell className="whitespace-nowrap align-top">
								<div className="max-w-xl whitespace-normal">
									<PermissionBadges role={role} />
								</div>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

export function CapabilityScopeReference() {
	return (
		<Table
			scrollLabel="MCP capability scopes"
			aria-label="MCP capability scopes"
		>
			<TableHeader>
				<TableRow>
					<TableHead sticky="left" className="min-w-56">
						Scope
					</TableHead>
					<TableHead>Permits</TableHead>
					<TableHead className="min-w-32">Granted to</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{CAPABILITY_SCOPES.map((scope) => {
					const meta = CAPABILITY_SCOPE_METADATA[scope];
					return (
						<TableRow key={scope}>
							<TableCell sticky="left" className="whitespace-nowrap align-top">
								<div className="space-y-1">
									<Text weight="medium">{meta.label}</Text>
									<Text as="code" role="label" tone="secondary">
										{scope}
									</Text>
								</div>
							</TableCell>
							<TableCell className="whitespace-nowrap align-top text-kumo-default">
								{meta.description}
							</TableCell>
							<TableCell className="align-top">
								<Badge variant={meta.humanOnly ? "secondary" : "outline"}>
									{meta.humanOnly ? "People only" : "People and tedis"}
								</Badge>
							</TableCell>
						</TableRow>
					);
				})}
			</TableBody>
		</Table>
	);
}

export function TeamRolesPanel() {
	return (
		<div className="grid gap-8">
			<Alert>
				<LockKey aria-hidden />
				<AlertTitle>Roles are fixed security boundaries</AlertTitle>
				<AlertDescription>
					Tedix exposes four organization roles so authorization stays
					consistent across the product and identity provider. Assign a role to
					each person on the Members tab.
				</AlertDescription>
			</Alert>

			<Card>
				<CardHeader className="grid-cols-1">
					<CardTitle className="flex items-center gap-2">
						<ShieldCheck aria-hidden className="size-5" />
						Organization roles
					</CardTitle>
					<CardDescription>
						Capabilities come from the canonical Tedix role contract. They are
						not customized per organization.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<RolePermissionsMatrix />
				</CardContent>
			</Card>

			<Card>
				<CardHeader className="grid-cols-1">
					<CardTitle className="flex items-center gap-2">
						<Key aria-hidden className="size-5" />
						MCP capability scopes
					</CardTitle>
					<CardDescription>
						What each scope permits when it is granted to an API key, an OAuth
						client, or a digital worker. Enforced on every MCP request.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<CapabilityScopeReference />
				</CardContent>
			</Card>

			<Text className="leading-relaxed" role="label" tone="secondary">
				Provider-level tenant administration and Tedix platform authority are
				separate from organization membership and cannot be assigned here.
			</Text>
		</div>
	);
}
