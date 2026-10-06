import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type {
	CalendarConfigurationSchema,
	CalendarPlanSchema,
} from "@tedix/api-contract/schemas/calendar-coordinator";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import type { PersonalResourceDelegationSchema } from "@tedix/api-contract/schemas/personal-resource-delegations";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import {
	CalendarResourcePicker,
	calendarResourceSelection,
	calendarAccountInput,
	calendarAccountLabel,
} from "./calendar-resource-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Checkbox } from "@/components/kumo/checkbox";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	osQuery,
	skillDetailQueryOptions,
	tediRosterQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";

type Configuration = z.infer<typeof CalendarConfigurationSchema>;
type Plan = z.infer<typeof CalendarPlanSchema>;
type Grant = z.infer<typeof PersonalResourceDelegationSchema>;
export type BoundCalendarResource = OsWorkspaceResource;
const ACTIONS = ["create", "update", "delete"] as const;
const actionLabels = {
	create: "Add private Busy blockers",
	update: "Move or resize owned blockers",
	delete: "Remove owned blockers when meetings cancel",
};
export function declaredCalendarTools(source: string): string[] {
	return Object.values(parseCapabilityManifest(source).mcp).flat();
}
export function calendarSkillReady(
	skill:
		| {
				tediId?: string | null;
				lifecycleState?: string | null;
				files?: Record<string, string | undefined> | null;
				content: string;
		  }
		| null
		| undefined,
	workerId: string,
) {
	return Boolean(
		workerId &&
		skill?.tediId === workerId &&
		["active", "proven", "crystallized"].includes(skill.lifecycleState ?? "") &&
		skill.files?.["scripts/workflow.ts"] &&
		declaredCalendarTools(skill.files?.["SKILL.md"] ?? skill.content).includes(
			"reconcile_calendar_subscription",
		),
	);
}
export function compensationCandidates(
	mutations: readonly {
		actionId: string;
		state: string;
		compensationEligible?: boolean;
	}[],
): string[] {
	return mutations
		.filter(
			(mutation) =>
				mutation.state === "confirmed" &&
				mutation.compensationEligible === true,
		)
		.slice(0, 20)
		.map((mutation) => mutation.actionId);
}
export function grantCoversCalendar(
	grant: Grant,
	resource: BoundCalendarResource,
	worker: string,
	skill: string,
	revision: number,
	actions: readonly string[],
	tools: string[],
	now = Date.now(),
) {
	return (
		!grant.revokedAt &&
		Date.parse(grant.expiresAt) > now &&
		grant.workspaceId === resource.workspaceId &&
		grant.resourceId === resource.id &&
		grant.connectionInstanceId === resource.connectionInstanceId &&
		grant.ownerUserId === resource.personalOwnerUserId &&
		grant.providerResourceId === resource.providerResourceId &&
		grant.tediId === worker &&
		grant.skillId === skill &&
		grant.skillRevision === revision &&
		grant.operations.includes("read") &&
		grant.operations.includes("subscribe") &&
		actions.every((action) => grant.operations.includes(action)) &&
		tools.every((tool) => grant.toolIds.includes(tool))
	);
}
export function CalendarPreview({
	plan,
	resources,
}: {
	plan: Plan;
	resources: BoundCalendarResource[];
}) {
	const name = (key: string) =>
		resources.find((resource) => resource.id === key)?.name ??
		"Selected calendar";
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>
					{plan.purpose === "compensate"
						? "Proposed undo"
						: "Proposed calendar changes"}
				</CardTitle>
				<CardDescription>
					This preview has not changed any calendar.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-2">
				<Text as="p">
					{plan.actions.length} proposed changes ·{" "}
					{plan.complete
						? "All selected calendars checked"
						: "Calendar checks incomplete"}
				</Text>
				{plan.conflicts.length > 0 && (
					<Alert variant="warning">
						<AlertTitle>Review needed</AlertTitle>
						<AlertDescription>
							{plan.conflicts.length} conflicts prevent safe calendar changes.
							Check account permissions or existing blockers, then refresh this
							preview.
							<details>
								<summary>Technical details</summary>
								<ul>
									{plan.conflicts.map((conflict, index) => (
										<li key={index}>{conflict}</li>
									))}
								</ul>
							</details>
						</AlertDescription>
					</Alert>
				)}

				<ul className="m-0 grid list-none gap-2 p-0">
					{plan.actions.map((action) => (
						<li key={action.id}>
							<Text as="p">
								{action.kind === "create"
									? "Add Busy blocker"
									: action.kind === "update"
										? "Update owned blocker"
										: "Clear owned busy time"}{" "}
								· {name(action.destinationKey)}
							</Text>
							<Text as="p" tone="secondary">
								{(action.after ?? action.before)?.start} —{" "}
								{(action.after ?? action.before)?.end}
							</Text>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
export function CalendarRemovalReceipt({
	mutations,
}: {
	mutations: readonly {
		state: string;
		removalMode?: "delete" | "release";
	}[];
}) {
	const released = mutations.filter(
		(mutation) =>
			mutation.state === "confirmed" && mutation.removalMode === "release",
	).length;
	if (released === 0) return null;
	return (
		<Text as="p" tone="secondary">
			Released busy time · {released} Outlook{" "}
			{released === 1 ? "blocker" : "blockers"}. Outlook keeps the private event
			marked as free, so it no longer blocks booking.
		</Text>
	);
}
export function coordinatorStatusText(
	mode: Configuration["mode"],
	monitoring: string | undefined,
) {
	if (mode !== "active") return "Preview only — calendar blocking is disabled";
	if (monitoring === "needs_attention")
		return "Calendar blocking needs attention — notification subscriptions are incomplete";
	if (monitoring !== "active")
		return "Enabled for reviewed changes — incoming calendar monitoring is not active";
	return "Calendar blocking enabled — incoming changes are monitored";
}
export function WorkspaceCalendarCoordinator({
	workspaceId,
}: {
	workspaceId: string;
}) {
	const queryClient = useQueryClient();
	const resourcesQuery = useQuery(workspaceResourcesQueryOptions(workspaceId));
	const configurations = useQuery({
		...osQuery.calendarCoordinator.list.queryOptions({
			input: { workspaceId },
		}),
		retry: false,
	});
	const accounts = useQuery({
		...osQuery.calendarCoordinator.supportedAccounts.queryOptions({
			input: { scope: "user" },
		}),
		retry: false,
	});
	const tenantAccounts = useQuery({
		...osQuery.calendarCoordinator.supportedAccounts.queryOptions({
			input: { scope: "tenant" },
		}),
		retry: false,
	});
	const tedis = useQuery(tediRosterQueryOptions(100, { status: "active" }));
	const grants = useQuery({
		...osQuery.personalResourceDelegations.list.queryOptions({
			input: { limit: 100 },
		}),
		retry: false,
	});
	const [configuration, setConfiguration] = useState<Configuration | null>(
		null,
	);
	const [resourceIds, setResourceIds] = useState<string[]>([]);
	const [workerId, setWorkerId] = useState("");
	const skills = useQuery({
		...osQuery.skills.listByOrg.queryOptions({
			input: { tediId: workerId, limit: 100, summary: false },
		}),
		enabled: Boolean(workerId),
	});
	const [skillId, setSkillId] = useState("");
	const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
	const [actions, setActions] = useState<Array<(typeof ACTIONS)[number]>>([
		...ACTIONS,
	]);
	const [expires, setExpires] = useState(() =>
		new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 16),
	);
	const [windowDays, setWindowDays] = useState("30");
	const [addCalendar, setAddCalendar] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [plan, setPlan] = useState<Plan | null>(null);
	const [undoReviewed, setUndoReviewed] = useState(false);
	const [deliveryModes, setDeliveryModes] = useState<
		Record<string, "push" | "poll">
	>({});
	const skillQuery = useQuery({
		...skillDetailQueryOptions(skillId),
		enabled: Boolean(skillId),
	});
	const skill = skillQuery.data?.entry;
	const resources = (resourcesQuery.data?.items ?? []).filter(
		(resource) =>
			resource.status === "active" && resource.resourceType === "calendar",
	) as BoundCalendarResource[];
	const selected = resources.filter((resource) =>
		resourceIds.includes(resource.id),
	);
	const allAccounts = [
		...(accounts.data ?? []),
		...(tenantAccounts.data ?? []),
	];
	const calendarChecks = useQueries({
		queries: selected.map((resource) => {
			const account = allAccounts.find(
				(row) =>
					row.connectionInstanceId === resource.connectionInstanceId &&
					row.providerId === resource.providerId &&
					row.connectionScope === resource.connectionScope,
			);
			return {
				...osQuery.calendarCoordinator.listCalendars.queryOptions({
					input: account
						? calendarAccountInput(account)
						: {
								adapter: "google",
								providerId: "unselected",
								connectionScope: "user",
								connectionInstanceId: "00000000-0000-4000-8000-000000000000",
							},
				}),
				enabled: Boolean(account),
				retry: false,
			};
		}),
	});
	const calendarsReady =
		selected.length >= 2 &&
		calendarChecks.every((check, index) => {
			const calendar = check.data?.calendars.find(
				(item) => item.id === selected[index]?.providerResourceId,
			);
			return (
				check.isSuccess &&
				calendar?.canRead &&
				calendar.canWrite &&
				(!(actions.includes("update") || actions.includes("delete")) ||
					calendar.conditionalWrites)
			);
		});
	const status = useQuery({
		...osQuery.calendarCoordinator.status.queryOptions({
			input: {
				id: configuration?.id ?? "00000000-0000-4000-8000-000000000000",
			},
		}),
		enabled: Boolean(configuration),
		retry: false,
		refetchInterval: configuration ? 15000 : false,
	});
	useEffect(() => {
		if (!configuration && configurations.data?.[0]) {
			const saved = configurations.data[0];
			setConfiguration(saved);
			setWorkerId(saved.tediId);
			setSkillId(saved.skillId);
			setReviewedRevision(saved.skillRevision);
			setResourceIds(
				saved.calendars.map((calendar) => calendar.workspaceResourceId),
			);
			setActions(saved.actions.length ? saved.actions : [...ACTIONS]);
			setWindowDays(String(saved.rollingDays));
			setDeliveryModes(
				Object.fromEntries(
					saved.calendars.map((calendar) => [
						calendar.workspaceResourceId,
						calendar.deliveryMode,
					]),
				),
			);
		}
	}, [configuration, configurations.data]);
	const tools = skill
		? declaredCalendarTools(skill.files?.["SKILL.md"] ?? skill.content)
		: [];
	const workerReady = (tedis.data?.data ?? []).some(
		(worker) =>
			worker.id === workerId &&
			worker.status === "active" &&
			worker.runtimeState !== "archived" &&
			!worker.retiredAt,
	);
	const executable = workerReady && calendarSkillReady(skill, workerId);
	const eligibleSkills = (skills.data?.entries ?? []).filter((entry) =>
		calendarSkillReady(entry, workerId),
	);
	const undoIds = compensationCandidates(
		status.data?.lastReceipt?.mutations ?? [],
	);
	const revisionValid = Boolean(skill && reviewedRevision === skill.revision);
	const owned = selected.filter(
		(resource) => resource.connectionScope === "user",
	);
	const bound =
		selected.length >= 2 &&
		selected.every(
			(resource) =>
				resource.connectionInstanceId &&
				(resource.connectionScope !== "user" || resource.personalOwnerUserId) &&
				allAccounts.some(
					(account) =>
						account.connectionInstanceId === resource.connectionInstanceId &&
						account.providerId === resource.providerId &&
						account.connectionScope === resource.connectionScope,
				),
		);
	const accessGranted =
		executable &&
		revisionValid &&
		owned.every((resource) =>
			(grants.data ?? []).some((grant) =>
				grantCoversCalendar(
					grant,
					resource,
					workerId,
					skillId,
					reviewedRevision!,
					actions,
					tools,
				),
			),
		);
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: osQuery.calendarCoordinator.list.key({
					input: { workspaceId },
				}),
			}),
			queryClient.invalidateQueries({
				queryKey: osQuery.calendarCoordinator.status.key(),
			}),
			queryClient.invalidateQueries({
				queryKey: osQuery.personalResourceDelegations.list.key(),
			}),
		]);
	};
	const attach = useMutation({
		mutationFn: async (
			choice: Parameters<typeof calendarResourceSelection>[0],
		) =>
			osApi.osWorkspaces.resources.create({
				workspaceId,
				selection: calendarResourceSelection(choice),
			}),
		onSuccess: async () => {
			setAddCalendar(false);
			await queryClient.invalidateQueries({
				queryKey: workspaceResourcesQueryOptions(workspaceId).queryKey,
			});
		},
	});
	const consent = useMutation({
		mutationFn: async () => {
			if (
				!acknowledged ||
				!bound ||
				!revisionValid ||
				!executable ||
				!tools.length ||
				!actions.length
			)
				throw new Error(
					"Review the selected calendars, worker, skill revision and actions first.",
				);
			const expiresAt = new Date(`${expires}Z`).toISOString();
			if (Date.parse(expiresAt) <= Date.now())
				throw new Error("Choose a future access expiry.");
			for (const resource of owned) {
				if (
					(grants.data ?? []).some((grant) =>
						grantCoversCalendar(
							grant,
							resource,
							workerId,
							skillId,
							reviewedRevision!,
							actions,
							tools,
						),
					)
				)
					continue;
				await osApi.personalResourceDelegations.create({
					workspaceId,
					resourceId: resource.id,
					connectionInstanceId: resource.connectionInstanceId!,
					tediId: workerId,
					skillId,
					skillRevision: reviewedRevision!,
					operations: ["read", "subscribe", ...actions],
					toolIds: tools,
					expiresAt,
				});
			}
		},
		onSuccess: async () => {
			setDirty(true);
			setPlan(null);
			await refresh();
		},
	});
	const configure = useMutation({
		mutationFn: async () => {
			if (!bound || !workerId || !revisionValid || !executable)
				throw new Error(
					"Choose at least two bound calendars, an active worker and a reviewed executable skill.",
				);
			const start = new Date();
			const days = Number(windowDays);
			if (!Number.isInteger(days) || days < 1 || days > 90)
				throw new Error("Preview between 1 and 90 days.");
			return osApi.calendarCoordinator.configure({
				...(configuration ? { id: configuration.id } : {}),
				workspaceId,
				expectedRevision: configuration?.revision ?? 0,
				tediId: workerId,
				skillId,
				skillRevision: reviewedRevision!,
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				windowMode: "rolling",
				rollingDays: days,
				window: {
					start: start.toISOString(),
					end: new Date(start.getTime() + days * 86400000).toISOString(),
				},
				calendars: selected.map((resource) => {
					const account = allAccounts.find(
						(row) => row.connectionInstanceId === resource.connectionInstanceId,
					)!;
					return {
						adapter: account.adapter,
						providerId: resource.providerId,
						connectionScope: resource.connectionScope,
						connectionInstanceId: resource.connectionInstanceId!,
						calendarId: resource.providerResourceId,
						workspaceResourceId: resource.id,
						key: resource.id,
						deliveryMode: deliveryModes[resource.id] ?? "push",
						delegationId:
							resource.connectionScope === "user"
								? (grants.data ?? []).find((grant) =>
										grantCoversCalendar(
											grant,
											resource,
											workerId,
											skillId,
											reviewedRevision!,
											actions,
											tools,
										),
									)?.id
								: undefined,
					};
				}),
			});
		},
		onSuccess: async (result) => {
			setConfiguration(result);
			setDirty(false);
			setPlan(null);
			await refresh();
		},
	});
	const preview = useMutation({
		mutationFn: async () => {
			if (!configuration || dirty)
				throw new Error("Save the current setup first.");
			return osApi.calendarCoordinator.preview({
				id: configuration.id,
				expectedRevision: configuration.revision,
			});
		},
		onSuccess: setPlan,
	});
	const enable = useMutation({
		mutationFn: async () => {
			if (
				!calendarsReady ||
				!configuration ||
				dirty ||
				!plan?.complete ||
				plan.purpose !== "reconcile" ||
				!actions.length ||
				plan.conflicts.length ||
				plan.configurationRevision !== configuration.revision ||
				!accessGranted ||
				!acknowledged
			)
				throw new Error(
					"Review a complete current preview and grant access first.",
				);
			return osApi.calendarCoordinator.activate({
				id: configuration.id,
				expectedRevision: configuration.revision,
				actions,
			});
		},
		onSuccess: async (result) => {
			setConfiguration(result);
			setDirty(false);
			setPlan(null);
			await refresh();
		},
	});
	const apply = useMutation({
		mutationFn: async () => {
			if (
				!configuration ||
				configuration.mode !== "active" ||
				dirty ||
				!plan?.complete ||
				plan.purpose !== "reconcile" ||
				!actions.length ||
				plan.conflicts.length ||
				plan.configurationRevision !== configuration.revision ||
				!acknowledged ||
				!accessGranted
			)
				throw new Error(
					"Review a complete current preview and access before applying changes.",
				);
			return osApi.calendarCoordinator.apply({
				id: configuration.id,
				expectedRevision: configuration.revision,
				planId: plan.id,
			});
		},
		onSuccess: async () => {
			setPlan(null);
			await refresh();
		},
	});
	const disable = useMutation({
		mutationFn: async () => {
			if (!configuration) throw new Error("No setup to disable.");
			return osApi.calendarCoordinator.deactivate({
				id: configuration.id,
				expectedRevision: configuration.revision,
			});
		},
		onSuccess: async (result) => {
			setConfiguration(result);
			setDirty(false);
			setPlan(null);
			await refresh();
		},
	});
	const revoke = useMutation({
		mutationFn: async (id: string) =>
			osApi.personalResourceDelegations.revoke({ id }),
		onSuccess: refresh,
	});
	const recover = useMutation({
		mutationFn: async () => {
			if (!configuration || !status.data?.lastReceipt)
				throw new Error("Load the latest result first.");
			return osApi.calendarCoordinator.recover({
				id: configuration.id,
				expectedRevision: configuration.revision,
				planId: status.data.lastReceipt.planId,
			});
		},
		onSuccess: refresh,
	});
	const undoPreview = useMutation({
		mutationFn: async () => {
			if (!configuration || dirty || !status.data?.lastReceipt)
				throw new Error(
					"Save or restore this setup and load its latest result first.",
				);
			const receipt = status.data.lastReceipt;
			return osApi.calendarCoordinator.previewCompensation({
				id: configuration.id,
				expectedRevision: configuration.revision,
				planId: receipt.planId,
				actionIds: compensationCandidates(receipt.mutations),
			});
		},
		onSuccess: (result) => {
			setPlan(result);
			setUndoReviewed(false);
		},
	});
	const undo = useMutation({
		mutationFn: async () => {
			if (
				!configuration ||
				dirty ||
				!undoReviewed ||
				!plan?.complete ||
				plan.purpose !== "compensate" ||
				plan.configurationRevision !== configuration.revision ||
				plan.conflicts.length
			)
				throw new Error("Review a complete current undo preview first.");
			return osApi.calendarCoordinator.compensate({
				id: configuration.id,
				expectedRevision: configuration.revision,
				planId: plan.id,
			});
		},
		onSuccess: async () => {
			setPlan(null);
			setUndoReviewed(false);
			if (configuration) {
				const latest = await osApi.calendarCoordinator.status({
					id: configuration.id,
				});
				setConfiguration(latest.configuration);
			}
			await refresh();
		},
	});
	const relevantGrants = (grants.data ?? []).filter(
		(grant) => grant.workspaceId === workspaceId && !grant.revokedAt,
	);
	const busy =
		attach.isPending ||
		consent.isPending ||
		configure.isPending ||
		preview.isPending ||
		enable.isPending ||
		disable.isPending ||
		revoke.isPending ||
		apply.isPending ||
		recover.isPending ||
		undoPreview.isPending ||
		undo.isPending;
	const error = [
		attach,
		consent,
		configure,
		preview,
		enable,
		apply,
		recover,
		undoPreview,
		undo,
		disable,
		revoke,
	].find((mutation) => mutation.isError)?.error;
	const change = () => {
		setDirty(true);
		setAcknowledged(false);
		setUndoReviewed(false);
		setPlan(null);
	};
	return (
		<Card size="sm">
			<CardHeader>
				<CardTitle>Calendar blocking</CardTitle>
				<CardDescription>
					Select calendars, review access, and preview private Busy blockers
					before enabling automatic coordination.
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4">
				{configurations.isError && (
					<Alert variant="warning">
						<AlertTitle>Calendar setup unavailable</AlertTitle>
						<AlertDescription>
							The server could not load calendar blocking. Activation is
							unavailable.
						</AlertDescription>
					</Alert>
				)}
				{configuration && (
					<>
						<Badge
							variant={configuration.mode === "active" ? "warning" : "outline"}
						>
							{coordinatorStatusText(
								configuration.mode,
								status.data?.monitoring,
							)}
						</Badge>
						{status.data && (
							<Text as="p" tone="secondary">
								{status.data.message} Last result:{" "}
								{status.data.lastReceipt?.outcome ??
									"No reconciliation recorded"}
								.
							</Text>
						)}
						{status.isError && (
							<Text as="p" tone="error">
								Monitoring status could not be checked.
							</Text>
						)}
					</>
				)}
				<Text as="p" role="label">
					1. Calendars to coordinate
				</Text>
				{resources.map((resource) => (
					<div key={resource.id} className="flex items-center gap-2">
						<Checkbox
							aria-label={`Include ${resource.name}`}
							checked={resourceIds.includes(resource.id)}
							onCheckedChange={(checked) => {
								change();
								setResourceIds((ids) =>
									checked === true
										? [...ids, resource.id]
										: ids.filter((id) => id !== resource.id),
								);
							}}
							disabled={busy}
						/>
						{resource.name} ·{" "}
						{allAccounts.find(
							(account) =>
								account.connectionInstanceId === resource.connectionInstanceId,
						)
							? calendarAccountLabel(
									allAccounts.find(
										(account) =>
											account.connectionInstanceId ===
											resource.connectionInstanceId,
									)!,
								)
							: "Account needs verification"}{" "}
						·{" "}
						{resource.connectionScope === "user"
							? "Personal account"
							: "Organization account"}
						{!resource.connectionInstanceId && " · Choose the account again"}
						<Select
							value={deliveryModes[resource.id] ?? "push"}
							disabled={busy}
							onValueChange={(value) => {
								if (value !== "push" && value !== "poll") return;
								change();
								setDeliveryModes((current) => ({
									...current,
									[resource.id]: value,
								}));
							}}
						>
							<SelectTrigger aria-label={`Monitoring for ${resource.name}`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="push">
									Receive immediate change notifications
								</SelectItem>
								<SelectItem value="poll">
									Check periodically (fallback)
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				))}
				<Button
					type="button"
					variant="outline"
					onClick={() => setAddCalendar((value) => !value)}
				>
					Add a calendar
				</Button>
				{addCalendar && (
					<CalendarResourcePicker
						disabled={busy}
						onSelect={(choice) => attach.mutate(choice)}
					/>
				)}
				<Text as="p" role="label">
					2. Worker and reviewed skill
				</Text>
				<Select
					value={workerId}
					onValueChange={(value) => {
						change();
						setWorkerId(value ?? "");
						setSkillId("");
						setReviewedRevision(null);
					}}
					disabled={busy}
				>
					<SelectTrigger aria-label="Calendar worker">
						<SelectValue placeholder="Choose a worker" />
					</SelectTrigger>
					<SelectContent>
						{(tedis.data?.data ?? [])
							.filter(
								(worker) =>
									worker.status === "active" &&
									worker.runtimeState !== "archived" &&
									!worker.retiredAt,
							)
							.map((worker) => (
								<SelectItem key={worker.id} value={worker.id}>
									{worker.displayName ?? worker.name}
								</SelectItem>
							))}
					</SelectContent>
				</Select>
				<Select
					value={skillId}
					onValueChange={(value) => {
						change();
						setSkillId(value ?? "");
						setReviewedRevision(null);
					}}
					disabled={busy}
				>
					<SelectTrigger aria-label="Calendar coordination skill">
						<SelectValue placeholder="Choose the calendar skill" />
					</SelectTrigger>
					<SelectContent>
						{eligibleSkills.map((entry) => (
							<SelectItem key={entry.id} value={entry.id}>
								{entry.title}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{skills.isError && (
					<Text as="p" tone="error">
						This worker's skills could not be checked. Activation is
						unavailable.
					</Text>
				)}
				{workerId && skills.isSuccess && !eligibleSkills.length && (
					<Text as="p" tone="error">
						This worker has no eligible calendar skill. Install an active
						executable calendar reconciliation skill for this worker before
						enabling calendar blocking.
					</Text>
				)}
				{skill && (
					<>
						<a href={`/skills/${skill.id}`}>
							Review skill instructions and workflow
						</a>
						<Text as="p">
							{skill.title} · Revision {skill.revision}
						</Text>
						<Button
							type="button"
							variant="outline"
							disabled={!executable}
							onClick={() => {
								change();
								setReviewedRevision(skill.revision);
							}}
						>
							Use this reviewed revision
						</Button>
						{!executable && (
							<Text as="p" tone="error">
								This skill must belong to the selected worker, be active, proven
								or crystallized, and include an executable calendar
								reconciliation workflow. Activation is unavailable.
							</Text>
						)}
					</>
				)}
				<Text as="p" role="label">
					3. Personal access
				</Text>
				<Text as="p">
					Read the selected calendars and monitor them using the methods
					selected above, and:
				</Text>
				{ACTIONS.map((action) => (
					<label key={action} className="flex items-center gap-2">
						<Checkbox
							aria-label={actionLabels[action]}
							checked={actions.includes(action)}
							onCheckedChange={(checked) => {
								change();
								setActions((current) =>
									checked === true
										? [...current, action]
										: current.filter((value) => value !== action),
								);
							}}
							disabled={busy}
						/>
						{actionLabels[action]}
					</label>
				))}
				<label>
					Access expires (UTC)
					<Input
						aria-label="Access expires (UTC)"
						type="datetime-local"
						value={expires}
						onChange={(event) => {
							change();
							setExpires(event.target.value);
						}}
					/>
				</label>
				<Text as="p" tone="secondary">
					Access applies only to these calendars, this worker and this skill
					revision. It can be revoked here. Meeting titles and attendees are not
					copied into blockers.
				</Text>
				<label className="flex items-center gap-2">
					<Checkbox
						aria-label="I reviewed the calendars, skill revision, actions and access expiry"
						checked={acknowledged}
						onCheckedChange={(value) => setAcknowledged(value === true)}
					/>
					I reviewed the calendars, skill revision, actions and access expiry.
				</label>
				{owned.length > 0 && (
					<Button
						type="button"
						variant="outline"
						disabled={
							busy ||
							!acknowledged ||
							!bound ||
							!revisionValid ||
							!executable ||
							!workerId ||
							!tools.length ||
							!actions.length ||
							grants.isError
						}
						onClick={() => consent.mutate()}
					>
						Grant selected personal access
					</Button>
				)}
				{grants.isError && (
					<Text as="p" tone="error">
						Personal access could not be checked. Activation is unavailable.
					</Text>
				)}
				{relevantGrants.map((grant) => (
					<div
						key={grant.id}
						className="flex flex-wrap items-center justify-between gap-2"
					>
						<Text as="p" tone="secondary">
							{resources.find((resource) => resource.id === grant.resourceId)
								?.name ?? "Calendar access"}{" "}
							· expires {grant.expiresAt}
						</Text>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => revoke.mutate(grant.id)}
						>
							Revoke access
						</Button>
					</div>
				))}
				<Text as="p" role="label">
					4. Preview and enable
				</Text>
				<label>
					Preview days
					<Input
						aria-label="Keep calendars aligned for the next (days)"
						type="number"
						min={1}
						max={90}
						value={windowDays}
						onChange={(event) => {
							change();
							setWindowDays(event.target.value);
						}}
					/>
				</label>
				{selected.length >= 2 && !calendarsReady && (
					<Text as="p" tone="error">
						Selected calendar permissions are incomplete or safe blocker updates
						are unavailable. Automatic coordination cannot be enabled.
					</Text>
				)}
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={
							busy ||
							configurations.isError ||
							!bound ||
							!workerId ||
							!revisionValid ||
							!executable
						}
						onClick={() => configure.mutate()}
					>
						Save setup
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={busy || !configuration || dirty}
						onClick={() => preview.mutate()}
					>
						Preview changes
					</Button>
					<Button
						type="button"
						disabled={
							busy ||
							!calendarsReady ||
							!configuration ||
							dirty ||
							!plan?.complete ||
							plan.purpose !== "reconcile" ||
							!actions.length ||
							Boolean(plan.conflicts.length) ||
							!accessGranted ||
							!acknowledged
						}
						onClick={() => enable.mutate()}
					>
						Enable blocker changes
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={
							busy ||
							configuration?.mode !== "active" ||
							dirty ||
							!plan?.complete ||
							plan.purpose !== "reconcile" ||
							!actions.length ||
							Boolean(plan.conflicts.length) ||
							!accessGranted ||
							!acknowledged
						}
						onClick={() => apply.mutate()}
					>
						Apply this preview
					</Button>
					{configuration?.mode === "active" && (
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => disable.mutate()}
						>
							Disable calendar blocking
						</Button>
					)}
				</div>
				<Text as="p" tone="secondary">
					Enabling installs the selected notification or periodic checking
					methods and starts reconciliation only when every selected account is
					ready. Monitoring status and the last result are reported separately
					above.
				</Text>

				{status.data?.lastSuccessfulReconcileAt && (
					<Text as="p" tone="secondary">
						Last successful calendar check:{" "}
						{new Date(status.data.lastSuccessfulReconcileAt).toLocaleString()}
					</Text>
				)}
				{status.data?.lastReceipt && (
					<div className="grid gap-2">
						<CalendarRemovalReceipt
							mutations={status.data.lastReceipt.mutations}
						/>
						{status.data.lastReceipt.mutations.some(
							(mutation) =>
								mutation.state === "uncertain" || mutation.state === "intent",
						) && (
							<>
								<Text as="p" tone="error">
									Some calendar changes have an unknown result. Check what was
									saved before retrying.
								</Text>
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => recover.mutate()}
								>
									Check uncertain changes
								</Button>
							</>
						)}
						{undoIds.length > 0 && (
							<>
								<Text as="p" tone="secondary">
									Undo reviews up to 20 eligible confirmed changes from the
									latest result. It pauses monitoring and restores only owned
									blockers that still match that result. Deleted blockers and
									changes without safe provider support cannot be undone here.
								</Text>
								<Button
									type="button"
									variant="outline"
									disabled={busy || dirty}
									onClick={() => undoPreview.mutate()}
								>
									Preview undo of latest changes
								</Button>
							</>
						)}
					</div>
				)}
				{plan && <CalendarPreview plan={plan} resources={resources} />}
				{plan?.purpose === "compensate" && (
					<div className="grid gap-2">
						<Checkbox
							aria-label="I reviewed this undo preview and understand monitoring will be disabled"
							label="I reviewed this undo preview and understand monitoring will be disabled"
							checked={undoReviewed}
							onCheckedChange={(value) => setUndoReviewed(value === true)}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={
								busy ||
								dirty ||
								!undoReviewed ||
								!plan.complete ||
								Boolean(plan.conflicts.length)
							}
							onClick={() => undo.mutate()}
						>
							Undo reviewed changes and disable monitoring
						</Button>
					</div>
				)}

				{error && (
					<Alert variant="destructive">
						<AlertTitle>Calendar setup needs attention</AlertTitle>
						<AlertDescription>{error.message}</AlertDescription>
					</Alert>
				)}
			</CardContent>
		</Card>
	);
}
