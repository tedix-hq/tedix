import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type * as z from "zod";
import { ExternalAgentWorkManagementGrantSchema } from "@tedix/api-contract/schemas/external-agent-identity";
import { Button } from "@/components/kumo/button";
import { SectionTitle } from "@/components/kumo/page";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workExternalPrincipalsQueryOptions,
	projectListQueryOptions,
} from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

type Grant = z.infer<typeof ExternalAgentWorkManagementGrantSchema>;

export function AgentWorkManagementApp({
	organizationId,
}: {
	organizationId: string;
}) {
	const context = useOsOperationalContext();
	const authorized =
		context.data?.organization.id === organizationId &&
		["owner", "admin"].includes(context.data.authority.role ?? "");
	const principals = useQuery({
		...workExternalPrincipalsQueryOptions(organizationId),
		enabled: authorized,
	});
	const projects = useQuery({
		...projectListQueryOptions(100),
		enabled: authorized,
	});
	if (!authorized)
		return (
			<p>
				Only an organization owner or admin can grant Work management rights.
			</p>
		);
	return (
		<section aria-label="Agent Work permissions" className="space-y-4">
			<SectionTitle>Agent Work permissions</SectionTitle>
			<p>
				Let a named agent edit or cancel Work in this organization or one
				project. Organization grants also allow moving Work between projects.
				Active Attempts stay protected. Payments, sign-ins, outgoing messages
				and deletes need their existing permissions.
			</p>
			{(principals.error || projects.error) && (
				<p role="alert">{(principals.error || projects.error)?.message}</p>
			)}
			{principals.isPending && <p role="status">Loading agents…</p>}
			{principals.data?.length === 0 && <p>No connected agents.</p>}
			{principals.data?.map((principal) => (
				<GrantControl
					key={`${principal.id}:${principal.updatedAt}`}
					organizationId={organizationId}
					principalId={principal.id}
					name={`${principal.displayName} (${principal.key})`}
					status={principal.status}
					current={principal.metadata.workManagement}
					projects={projects.data?.data ?? []}
				/>
			))}
		</section>
	);
}

function GrantControl({
	organizationId,
	principalId,
	name,
	status,
	current,
	projects,
}: {
	organizationId: string;
	principalId: string;
	name: string;
	status: string;
	current: unknown;
	projects: { id: string; name: string }[];
}) {
	const parsed = ExternalAgentWorkManagementGrantSchema.safeParse(current);
	const grant = parsed.success ? parsed.data : null;
	const [scope, setScope] = useState(
		grant && "scope" in grant && grant.scope === "project"
			? grant.projectId
			: "organization",
	);
	const [actions, setActions] = useState<Grant["actions"]>(
		grant?.actions ?? ["specification", "cancellation"],
	);
	const cache = useQueryClient();
	const change = useMutation({
		mutationFn: (next: Grant | null) =>
			osApi.externalAgentIdentity.setWorkManagement({
				organizationId,
				principalId,
				grant: next,
			}),
		onSuccess: () =>
			cache.invalidateQueries({
				queryKey: osQuery.externalAgentIdentity.listPrincipals.key(),
			}),
	});
	return (
		<div
			className="space-y-3 rounded border p-3"
			aria-label={`Work permissions for ${name}`}
		>
			<p>
				<strong>{name}</strong> · {status}
			</p>
			<p>
				{grant
					? "scope" in grant
						? grant.scope === "organization"
							? "Granted for all Work"
							: "Granted for one project"
						: "Granted for source prefixes"
					: "No Work management grant"}
			</p>
			<Select
				value={scope}
				onValueChange={(value) => {
					if (value !== null) setScope(value);
				}}
			>
				<SelectTrigger aria-label={`Work scope for ${name}`}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="organization">All Work in organization</SelectItem>
					{projects.map((project) => (
						<SelectItem key={project.id} value={project.id}>
							{project.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<div className="flex flex-wrap gap-2">
				{(
					[
						["specification", "Edit and re-file"],
						["cancellation", "Cancel"],
						["assignment", "Assign executor"],
					] as const
				).map(([action, label]) => (
					<Button
						key={action}
						variant={actions.includes(action) ? "secondary" : "outline"}
						aria-pressed={actions.includes(action)}
						onClick={() =>
							setActions(
								actions.includes(action)
									? actions.filter((entry) => entry !== action)
									: [...actions, action],
							)
						}
					>
						{label}
					</Button>
				))}
			</div>
			<div className="flex gap-2">
				<Button
					disabled={
						change.isPending || status !== "active" || actions.length === 0
					}
					onClick={() =>
						change.mutate(
							scope === "organization"
								? { scope, actions }
								: { scope: "project", projectId: scope, actions },
						)
					}
				>
					Save grant
				</Button>
				<Button
					variant="outline"
					disabled={change.isPending || current === undefined}
					onClick={() => change.mutate(null)}
				>
					Revoke grant
				</Button>
			</div>
			{change.isPending && <p role="status">Saving…</p>}
			{change.error && <p role="alert">{change.error.message}</p>}
			{change.isSuccess && <p role="status">Work permissions saved.</p>}
		</div>
	);
}
