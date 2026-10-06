/**
 * What one member can actually do.
 *
 * The Team page showed a role label and nothing else, so an administrator had
 * no way to answer "what does Admin let this person do?" without reading
 * `ROLE_PERMISSION_GRANTS` in the source. This renders that exact map — the one
 * every API guard evaluates — for a single member.
 *
 * Shows both sources the API evaluates for a member, labelled:
 *
 *  - the role's grants, from `ROLE_PERMISSION_GRANTS`; and
 *  - the additive overrides stored on the member row, which
 *    `userHoldsPermission` now honors, bounded to what the `owner` role itself
 *    holds so an override can never carry `platform:admin`.
 *
 * A member's Descope token may additionally carry permissions granted directly
 * in the identity provider, which `userHoldsPermission` also honors. We cannot
 * read another user's token, so the footnote says so rather than implying this
 * list is exhaustive.
 */

import type { MemberRole } from "@tedix/api-contract/schemas/organization";
import {
	describeRolePermissions,
	PERMISSION_GROUPS,
	PERMISSION_METADATA,
	type Permission,
	type PermissionGroup,
	ROLE_METADATA,
	TENANT_GRANTABLE_PERMISSIONS,
} from "@tedix/auth/rbac";
import { useState } from "react";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Checkbox } from "@/components/kumo/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";

const GROUP_LABELS: Record<PermissionGroup, string> = {
	apps: "Apps",
	tedis: "Digital workers",
	os: "OS",
	team: "Organization",
	billing: "Billing",
	platform: "Platform",
};

export interface MemberAccessSubject {
	id: string;
	email: string;
	name: string | null;
	role: MemberRole;
	customPermissions: readonly Permission[] | null;
}

export function MemberAccessDialog({
	member,
	onClose,
	canManage,
	onSave,
	isSaving,
}: {
	member: MemberAccessSubject | null;
	onClose: () => void;
	/** Whether the viewer may edit overrides (`team:manage`). */
	canManage: boolean;
	onSave: (memberId: string, permissions: Permission[]) => void;
	isSaving: boolean;
}) {
	if (!member) return null;
	return (
		<MemberAccessDialogBody
			canManage={canManage}
			isSaving={isSaving}
			key={member.id}
			member={member}
			onClose={onClose}
			onSave={onSave}
		/>
	);
}

function MemberAccessDialogBody({
	member,
	onClose,
	canManage,
	onSave,
	isSaving,
}: {
	member: MemberAccessSubject;
	onClose: () => void;
	canManage: boolean;
	onSave: (memberId: string, permissions: Permission[]) => void;
	isSaving: boolean;
}) {
	const role = ROLE_METADATA[member.role];
	const permissions = describeRolePermissions(member.role);
	const roleGrants = new Set<Permission>(
		permissions.map((entry) => entry.permission),
	);
	const [overrides, setOverrides] = useState<Permission[]>(() =>
		[...(member.customPermissions ?? [])].filter(
			(permission) => !roleGrants.has(permission),
		),
	);
	// Only what the role does NOT already grant is worth offering: an override
	// is additive, so granting something the role holds changes nothing.
	const grantable = TENANT_GRANTABLE_PERMISSIONS.filter(
		(permission) => !roleGrants.has(permission),
	);
	const dirty =
		JSON.stringify([...overrides].sort()) !==
		JSON.stringify(
			[...(member.customPermissions ?? [])]
				.filter((p) => !roleGrants.has(p))
				.sort(),
		);

	return (
		<Dialog onOpenChange={(open) => !open && onClose()} open>
			<DialogContent size="xl">
				<DialogHeader>
					<DialogTitle>Access for {member.name || member.email}</DialogTitle>
					<DialogDescription>
						Everything the {role.label} role grants. These are the exact
						permissions the API checks.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<Badge variant="secondary">{role.label}</Badge>
						<Text as="span" role="label" tone="secondary">
							{role.responsibility} · {permissions.length} from role
							{overrides.length > 0 ? ` · ${overrides.length} additional` : ""}
						</Text>
					</div>

					<Surface className="grid max-h-80 grid-cols-1 gap-3 overflow-y-auto p-3 sm:grid-cols-2">
						{permissions.length === 0 ? (
							<Text role="body" tone="secondary">
								This role grants no permissions.
							</Text>
						) : (
							PERMISSION_GROUPS.map((group) => {
								const inGroup = permissions.filter(
									(entry) => entry.group === group,
								);
								if (inGroup.length === 0) return null;
								return (
									<section key={group}>
										<Text
											as="h3"
											className="mb-1 uppercase tracking-wide"
											role="caption"
											tone="secondary"
											weight="medium"
										>
											{GROUP_LABELS[group]}
										</Text>
										<ul className="space-y-1.5">
											{inGroup.map((entry) => (
												<li key={entry.permission}>
													<div className="flex flex-wrap items-baseline gap-2">
														<Text as="span" weight="medium">
															{entry.label}
														</Text>
														<Text as="code" role="label" tone="secondary">
															{entry.permission}
														</Text>
														<Badge variant="outline">From role</Badge>
													</div>
													<Text role="label" tone="secondary">
														{entry.description}
													</Text>
												</li>
											))}
										</ul>
									</section>
								);
							})
						)}
					</Surface>

					<section>
						<Text as="h3" className="mb-1" weight="medium">
							Additional permissions
						</Text>
						<Text className="mb-2" role="label" tone="secondary">
							Granted on top of the role. Cannot exceed what Owner holds, so
							platform authority can never be granted here.
						</Text>
						{overrides.length === 0 && !canManage ? (
							<Text role="body" tone="secondary">
								No additional permissions.
							</Text>
						) : (
							<Surface className="grid max-h-80 grid-cols-1 gap-1.5 overflow-y-auto p-3 sm:grid-cols-2">
								{grantable.map((permission) => {
									const meta = PERMISSION_METADATA[permission];
									const checked = overrides.includes(permission);
									if (!canManage && !checked) return null;
									return (
										<Checkbox
											checked={checked}
											disabled={!canManage || isSaving}
											key={permission}
											label={
												<span className="flex flex-col">
													<Text as="span">
														{meta.label}{" "}
														<Text as="code" role="label" tone="secondary">
															{permission}
														</Text>
													</Text>
													<Text as="span" role="label" tone="secondary">
														{meta.description}
													</Text>
												</span>
											}
											onCheckedChange={(next) =>
												setOverrides((current) =>
													next === true
														? [...current, permission]
														: current.filter((entry) => entry !== permission),
												)
											}
										/>
									);
								})}
							</Surface>
						)}
					</section>

					{canManage ? (
						<div className="flex justify-end gap-2">
							<Button onClick={onClose} variant="outline">
								Cancel
							</Button>
							<Button
								disabled={!dirty || isSaving}
								onClick={() => onSave(member.id, overrides)}
							>
								{isSaving ? "Saving…" : "Save permissions"}
							</Button>
						</div>
					) : null}

					<Text className="leading-relaxed" role="label" tone="secondary">
						Change the baseline by changing the role. Permissions granted
						directly in the identity provider are honored by the API but are not
						listed here.
					</Text>
				</div>
			</DialogContent>
		</Dialog>
	);
}
