import { CaretRight } from "@phosphor-icons/react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
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
						key={`${group.name}:${(expandHighRisk && group.highRisk) || Boolean(term)}`}
						className="overflow-hidden bg-kumo-tint"
						render={
							<Collapsible
								defaultOpen={
									(expandHighRisk && group.highRisk) || Boolean(term)
								}
							/>
						}
					>
						<CollapsibleTrigger className="group/disclosure w-full justify-between gap-3 px-4 py-3.5">
							<CaretRight
								size={14}
								aria-hidden
								className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
							/>
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
						</CollapsibleTrigger>
						<CollapsibleContent keepMounted>
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
						</CollapsibleContent>
					</Surface>
				))}
			</div>
			{permissions.length > 0 ? (
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure">
						<CaretRight
							size={14}
							aria-hidden
							className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
						Permission codes
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<ul className="grid gap-1 pt-2">
							{permissions.map((permission) => (
								<li key={permission.name}>
									<CodeInline tone="secondary" className="break-all">
										{permission.name}
									</CodeInline>
								</li>
							))}
						</ul>
					</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}
