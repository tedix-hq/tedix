import { Badge } from "@/components/kumo/badge";
import { CodeInline } from "@/components/kumo/code";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { Input } from "@/components/kumo/input";
import { Checkbox } from "@/components/kumo/checkbox";
import { useState } from "react";
import {
	groupConsentPermissions,
	type ConsentPermission,
} from "@/shared/consent-permissions";

/**
 * Native `<details>` keeps the disclosure working with no JavaScript, which a
 * consent screen inside a third-party OAuth transaction genuinely wants. The
 * bounded box, dividers, and typography come from the adapters; only the
 * disclosure element itself stays native.
 */
export function ConsentPermissionGroups({
	permissions,
	selectedScopes,
	onSelectionChange,
	expandHighRisk = true,
}: {
	permissions: readonly ConsentPermission[];
	selectedScopes?: readonly string[];
	onSelectionChange?: (scopes: string[]) => void;
	expandHighRisk?: boolean;
}) {
	const [search, setSearch] = useState("");
	const selected = new Set(selectedScopes);
	const term = search.trim().toLowerCase();
	const groups = groupConsentPermissions(permissions)
		.map((group) => ({
			...group,
			permissions: group.permissions.filter((permission) =>
				`${group.name} ${permission.name} ${permission.description}`
					.toLowerCase()
					.includes(term),
			),
		}))
		.filter((group) => group.permissions.length > 0);
	const permissionCount = term
		? groups.reduce((count, group) => count + group.permissions.length, 0)
		: permissions.length;
	return (
		<div className="grid gap-3">
			{permissions.length > 6 ? (
				<Input
					type="search"
					aria-label="Search permissions"
					placeholder="Search permissions…"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			) : null}
			{!onSelectionChange || term ? (
				<Text role="label" tone="secondary">
					{`${permissionCount}${term ? " matching" : ""} permission${permissionCount === 1 ? "" : "s"}`}
				</Text>
			) : null}
			<div className="grid max-h-96 auto-rows-max gap-2 overflow-y-auto pr-1">
				{groups.map((group) => (
					<Surface
						key={group.name}
						className="overflow-hidden bg-kumo-tint"
						render={
							<details
								open={(expandHighRisk && group.highRisk) || Boolean(term)}
							/>
						}
					>
						<summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3.5 [list-style-position:inside]">
							<Text as="span" role="body" weight="semibold">
								{group.name}
							</Text>
							<span className="ml-auto inline-flex items-center gap-1.5">
								<Badge variant="secondary">
									{onSelectionChange
										? `${group.permissions.filter((permission) => selected.has(permission.name)).length} selected`
										: group.permissions.length}
								</Badge>
							</span>
						</summary>
						<ul className="grid divide-y divide-kumo-line border-kumo-line border-t">
							{group.permissions.map((permission) => (
								<li
									key={permission.name}
									className="flex items-center justify-between gap-4 px-4 py-3 max-[560px]:items-start"
								>
									{onSelectionChange ? (
										<Checkbox
											checked={selected.has(permission.name)}
											disabled={permission.required}
											aria-label={`Allow ${permission.description}`}
											onCheckedChange={(checked) => {
												const next = new Set(selected);
												if (checked) next.add(permission.name);
												else next.delete(permission.name);
												onSelectionChange(
													permissions
														.filter((candidate) => next.has(candidate.name))
														.map((candidate) => candidate.name),
												);
											}}
										/>
									) : null}
									<span className="grid min-w-0 gap-0.5">
										<Text as="span" role="body" weight="medium">
											{permission.description}
										</Text>
									</span>
									{permission.required ? (
										<Badge variant="secondary">Required</Badge>
									) : null}
									{permission.admin ? (
										<Badge variant="destructive">Manage</Badge>
									) : null}
								</li>
							))}
						</ul>
					</Surface>
				))}
			</div>
			{permissions.length > 0 ? (
				<details>
					<summary className="cursor-pointer text-kumo-subtle">
						Permission codes
					</summary>
					<ul className="grid gap-1 pt-2">
						{permissions.map((permission) => (
							<li key={permission.name}>
								<CodeInline tone="secondary" className="break-all">
									{permission.name}
								</CodeInline>
							</li>
						))}
					</ul>
				</details>
			) : null}
		</div>
	);
}
