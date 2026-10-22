/** Tedix OS ownership of the governed digital-worker settings seam. */

import { Alert } from "@/components/kumo/alert";
import { ListSkeleton } from "@/components/list-skeleton";
import { Collection } from "@/components/kumo/page";
import { ConfirmDialog } from "@/components/confirm-dialog";

import { TediConsoleAccess } from "./tedi-console-access";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import { canManageBrowserEgress } from "@tedix/api-contract/schemas/tedi";
import { BrowserConsoleSignIn } from "@/components/browser-console-sign-in";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import type {
	QuietHours,
	SelfImprovementPolicy,
	TediBudgets,
	ToolPolicy,
} from "@tedix/api-contract/schemas/tedi";
import { ArrowsClockwise, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import type * as z from "zod";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { getAuthenticatedOsApi, osApi } from "@/lib/api";
import { errorMessage } from "@/lib/orpc-error";
import {
	modelCatalogQueryOptions,
	appListQueryOptions,
	osQuery,
	osQueryKeys,
	tediDetailQueryOptions,
	tediDevicesQueryOptions,
	tediDomainsQueryOptions,
	tediRuntimeStatusQueryOptions,
	tediAppAssignmentsQueryOptions,
	tediSecretsQueryOptions,
} from "@/lib/os-query-options";
import { useStepUpAuth } from "@/lib/step-up-auth";
import {
	TEDIS_DELETE_DENIED_REASON,
	TEDIS_MANAGE_DENIED_REASON,
	TEDI_SECRETS_MANAGE_DENIED_REASON,
	TEDI_SECRETS_UNKNOWN_REASON,
	useCanManageTediSecrets,
	useCanReadTediSecrets,
	useCanDeleteTedis,
	useCanManageTedis,
} from "@/lib/tedi-permissions";

import {
	LiveChannelsForm,
	useTediSettingsChannels,
} from "./tedi-settings-channels";
import {
	SettingsRecordRow,
	ModelSettingsForm,
	SecretSettingsForm,
	AppAssignmentForm,
	CustomDomainForm,
	IdentitySettingsForm,
	RepositorySettingsForm,
	GovernanceSettingsForm,
	modelOverride,
	prettyJson,
	secretSettingsSchema,
	useTediAppAssignments,
	customDomainSchema,
} from "./tedi-settings-forms";

export function TediSettingsPage({ tediId }: { tediId: string }) {
	const queryClient = useQueryClient();
	const [resetOpen, setResetOpen] = useState(false);
	const [retireOpen, setRetireOpen] = useState(false);
	const navigate = useNavigate();
	const canManage = useCanManageTedis();
	const authority = useOsOperationalContext().data?.authority;
	const canManageEgress = canManageBrowserEgress(
		authority?.authType,
		authority?.role,
	);
	const canDelete = useCanDeleteTedis();
	const canReadSecrets = useCanReadTediSecrets();
	const canManageSecrets = useCanManageTediSecrets();
	const tedi = useQuery(tediDetailQueryOptions(tediId));
	const runtime = useQuery(tediRuntimeStatusQueryOptions(tediId));
	const models = useQuery(modelCatalogQueryOptions(tediId));
	const secrets = useQuery({
		...tediSecretsQueryOptions(tediId),
		enabled: canReadSecrets,
	});
	const devices = useQuery(tediDevicesQueryOptions(tediId));
	const domains = useQuery(tediDomainsQueryOptions(tediId));
	const assignments = useQuery(tediAppAssignmentsQueryOptions(tediId));
	const apps = useQuery(appListQueryOptions(100));
	const runtimeOverrides = tedi.data?.runtimeOverrides as
		| { agents?: { defaults?: { model?: { primary?: string } } } }
		| null
		| undefined;
	const selectedModel =
		runtimeOverrides?.agents?.defaults?.model?.primary ?? "";

	const invalidateTedi = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.tediAppAssignments(),
			}),
		]);

	const {
		channelValues,
		pairingRequests,
		saveChannels,
		testChannelToken,
		approvePairing,
	} = useTediSettingsChannels(tediId, tedi, invalidateTedi);

	const update = useMutation({
		...osQuery.tedis.update.mutationOptions(),
		onSuccess: async () => {
			await Promise.all([
				invalidateTedi(),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.modelCatalog() }),
			]);
			toast.success("Tedi settings saved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to save tedi settings")),
	});

	const run = useMutation({
		mutationFn: async (action: "wake" | "recover" | "repair" | "sync") => {
			if (action === "wake") return osApi.tedis.wake({ tediId });
			if (action === "recover")
				return osApi.tedis.wake({
					tediId,
					allowSandboxReset: true,
					reason: "Operator requested safe workstation recovery",
				});
			if (action === "repair") return osApi.tedis.repair({ tediId });
			return osApi.tedis.syncConfig({ tediId, force: true });
		},
		onSuccess: async (_data, action) => {
			await invalidateTedi();
			toast.success(
				action === "wake"
					? "Wake requested"
					: action === "recover"
						? "Recovery wake requested"
						: action === "repair"
							? "Repair completed"
							: "Configuration synced",
			);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Runtime action failed")),
	});

	const setSecret = useMutation({
		mutationFn: (value: z.output<typeof secretSettingsSchema>) =>
			osApi.tediSecrets.set({
				tediId,
				name: value.name,
				value: value.value,
			}),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]);
			toast.success("Secret saved");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to save secret")),
	});

	const deleteSecret = useMutation({
		mutationFn: (secretId: string) =>
			osApi.tediSecrets.delete({ tediId, secretId }),
		onMutate: async (secretId) => {
			const key = tediSecretsQueryOptions(tediId).queryKey;
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			queryClient.setQueryData(key, (current: typeof secrets.data) =>
				current
					? {
							...current,
							data: current.data.filter((row) => row.id !== secretId),
						}
					: current,
			);
			return { previous, key };
		},
		onError: (error, _secretId, context) => {
			if (context?.previous)
				queryClient.setQueryData(context.key, context.previous);
			toast.error(errorMessage(error, "Failed to delete secret"));
		},
		onSettled: () =>
			Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
			]),
	});

	const { createAssignment, updateAssignmentRole, deleteAssignment } =
		useTediAppAssignments(tediId);

	const deviceAction = useMutation({
		mutationFn: async ({
			id,
			action,
		}: {
			id: string;
			action: "approve" | "revoke";
		}) => {
			if (action === "approve") {
				await osApi.tedis.approveDevice({ tediId, deviceId: id });
			} else {
				await osApi.tedis.revokeDevice({ tediId, deviceId: id });
			}
		},
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
		onError: (error) =>
			toast.error(errorMessage(error, "Device action failed")),
	});

	const addDomain = useMutation({
		mutationFn: (value: z.output<typeof customDomainSchema>) =>
			osApi.tedis.addCustomDomain({ tediId, hostname: value.hostname }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() });
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to add domain")),
	});

	const removeDomain = useMutation({
		mutationFn: (domainId: string) =>
			osApi.tedis.removeCustomDomain({ tediId, domainId }),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
	});

	const resetSandbox = useMutation({
		mutationFn: () =>
			osApi.tedis.resetSandbox({
				tediId,
				reason: "Operator requested non-force workstation reset",
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() });
			setResetOpen(false);
			toast.success(
				"Workstation sandbox reset; next wake creates a fresh lease",
			);
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Safe sandbox reset failed")),
	});

	const {
		requireStepUp: requireRotateStepUp,
		StepUpDialog: RotateStepUpDialog,
	} = useStepUpAuth({
		title: "Confirm access-key rotation",
		description:
			"Rotating replaces the tedi identity credential and refreshes runtime configuration.",
		onFailure: (message) => toast.error(message),
	});
	const rotateAccessKey = useMutation({
		mutationFn: (token: string) =>
			getAuthenticatedOsApi(token).tedis.rotateAccessKey({ tediId }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tedis() }),
				queryClient.invalidateQueries({ queryKey: osQueryKeys.tediSecrets() }),
			]);
			toast.success("Tedi access key rotated and runtime config refreshed");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to rotate tedi access key")),
	});

	const retire = useMutation({
		mutationFn: () => osApi.tedis.delete({ tediId }),
		onSuccess: async () => {
			await invalidateTedi();
			setRetireOpen(false);
			toast.success("Tedi retired; cognitive history was retained");
			navigate({ to: "/team", search: { tab: "tedis", page: 1 } });
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Failed to retire tedi")),
	});

	if (tedi.isPending)
		return (
			<div role="status" aria-label="Loading settings…">
				<ListSkeleton rows={3} />
			</div>
		);
	if (tedi.isError) {
		return <Alert variant="destructive">Tedi settings are unavailable.</Alert>;
	}

	const assignedAppIds = new Set(
		(assignments.data?.data ?? []).map((assignment) => assignment.appId),
	);
	const appNames = new Map(
		(apps.data?.data ?? []).map((app) => [app.id, app.name]),
	);

	return (
		<div className="space-y-6">
			<div>
				<Text as="h2" role="title" weight="semibold">
					Settings
				</Text>
				<Text role="body" tone="secondary">
					Identity, runtime, credentials, devices, domains, and lifecycle.
				</Text>
			</div>

			{!canManage ? (
				<div role="note">
					<Text role="label" tone="secondary">
						{TEDIS_MANAGE_DENIED_REASON}
					</Text>
				</div>
			) : null}

			<TediConsoleAccess tediId={tediId} />
			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Identity & personality</CardTitle>
					</CardHeader>
					<CardContent>
						<IdentitySettingsForm
							values={{
								displayName: tedi.data.displayName ?? "",
								personality: tedi.data.personality ?? "",
								language: tedi.data.language ?? "en",
								timezone: tedi.data.timezone ?? "UTC",
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									displayName: value.displayName || null,
									personality: value.personality || null,
									language: value.language,
									timezone: value.timezone,
								})
							}
						/>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Model & runtime</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<ModelSettingsForm
							value={selectedModel}
							models={models.data?.models ?? []}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									runtimeOverrides: modelOverride(
										tedi.data.runtimeOverrides,
										value.model,
									),
								})
							}
						/>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("wake")}
							>
								Wake
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("recover")}
							>
								Recover wake
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("sync")}
								icon={<ArrowsClockwise className="size-4" />}
							>
								Sync config
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!canManage || run.isPending}
								onClick={() => run.mutate("repair")}
							>
								Repair credentials
							</Button>
						</div>
						<Text role="label" tone="secondary">
							Runtime:{" "}
							{runtime.data?.runtimeStatus ??
								tedi.data.runtimeStatus ??
								"unknown"}
							. Restart was removed for Agent-runtime tedis; wake/status are
							canonical.
						</Text>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Live channels</CardTitle>
				</CardHeader>
				<CardContent className="space-y-5">
					<Text role="body" tone="secondary">
						Saving preserves channel fields owned by the runtime. Credential and
						config-sync failures are reported as partial outcomes.
					</Text>
					<LiveChannelsForm
						values={channelValues}
						canManage={canManage}
						canReadSecrets={canReadSecrets}
						canManageSecrets={canManageSecrets}
						isSaving={saveChannels.isPending}
						isTesting={testChannelToken.isPending}
						onSave={(value) =>
							saveChannels
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
						onTest={(channel, token) =>
							testChannelToken.mutate({ channel, token })
						}
					/>
					{(pairingRequests.data?.pending ?? []).length ? (
						<Surface className="space-y-2 p-3">
							<Text role="body" weight="medium">
								Pending Telegram pairings
							</Text>
							<Collection aria-label="Pending Telegram pairings">
								{(pairingRequests.data?.pending ?? []).map((request) => (
									<SettingsRecordRow
										key={request.code}
										title={
											<Text role="body">
												{request.senderName ?? request.senderId ?? request.code}
											</Text>
										}
										trailing={
											<Button
												size="sm"
												disabled={!canManage || approvePairing.isPending}
												onClick={() => approvePairing.mutate(request.code)}
											>
												Approve pairing
											</Button>
										}
									/>
								))}
							</Collection>
						</Surface>
					) : null}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Encrypted credentials</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					{!canReadSecrets ? (
						<div role="note">
							<Text role="label" tone="secondary">
								{TEDI_SECRETS_UNKNOWN_REASON}
							</Text>
						</div>
					) : !canManageSecrets ? (
						<div role="note">
							<Text role="label" tone="secondary">
								{TEDI_SECRETS_MANAGE_DENIED_REASON}
							</Text>
						</div>
					) : null}
					<SecretSettingsForm
						disabled={!canManageSecrets || setSecret.isPending}
						onSave={(value) =>
							setSecret
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
					/>
					<Collection aria-label="Encrypted credentials">
						{(secrets.data?.data ?? []).map((secret) => (
							<SettingsRecordRow
								key={secret.id}
								title={
									<Text as="p" role="body" tone="mono">
										{secret.name}
									</Text>
								}
								description={secret.hint}
								trailing={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Delete ${secret.name}`}
										disabled={!canManageSecrets || deleteSecret.isPending}
										onClick={() => deleteSecret.mutate(secret.id)}
										icon={<Trash className="size-4" />}
									></Button>
								}
							/>
						))}
					</Collection>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>App assignments</CardTitle>
				</CardHeader>
				<CardContent className="space-y-4">
					<AppAssignmentForm
						apps={(apps.data?.data ?? []).filter(
							(app) => !assignedAppIds.has(app.id),
						)}
						disabled={!canManage || createAssignment.isPending}
						onSave={(value) =>
							createAssignment
								.mutateAsync(value)
								.then(() => true)
								.catch(() => false)
						}
					/>
					<Collection aria-label="App assignments">
						{(assignments.data?.data ?? []).map((assignment) => (
							<SettingsRecordRow
								key={assignment.id}
								title={
									<Text role="body" weight="medium">
										{appNames.get(assignment.appId) ?? assignment.appId}
									</Text>
								}
								trailing={
									<div className="flex items-center gap-2">
										<Select
											value={assignment.role}
											disabled={!canManage || updateAssignmentRole.isPending}
											onValueChange={(value) =>
												value &&
												updateAssignmentRole.mutate({
													assignmentId: assignment.id,
													role: value as TediAppAssignmentRole,
												})
											}
										>
											<SelectTrigger
												className="w-32"
												aria-label="Assigned role"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="operator">Operator</SelectItem>
												<SelectItem value="observer">Observer</SelectItem>
											</SelectContent>
										</Select>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Unassign app"
											disabled={!canManage || deleteAssignment.isPending}
											onClick={() => deleteAssignment.mutate(assignment.id)}
											icon={<Trash className="size-4" />}
										></Button>
									</div>
								}
							/>
						))}
					</Collection>
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Repository</CardTitle>
					</CardHeader>
					<CardContent>
						<RepositorySettingsForm
							values={{
								repoUrl: tedi.data.repoConfig?.repoUrl ?? "",
								repoBranch: tedi.data.repoConfig?.branch ?? "main",
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									repoConfig: value.repoUrl
										? {
												repoUrl: value.repoUrl,
												branch: value.repoBranch || undefined,
											}
										: null,
								})
							}
						/>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Spending and approvals</CardTitle>
					</CardHeader>
					<CardContent>
						<BrowserConsoleSignIn
							policy={tedi.data.toolPolicy}
							disabled={!canManage || !canManageEgress || update.isPending}
							onChange={(toolPolicy) => update.mutate({ tediId, toolPolicy })}
						/>
						<GovernanceSettingsForm
							values={{
								toolPolicyJson: prettyJson(tedi.data.toolPolicy),
								learningPolicyJson: prettyJson(tedi.data.selfImprovementPolicy),
								budgetsJson: prettyJson(tedi.data.budgets),
								quietHoursJson: prettyJson(tedi.data.quietHours),
							}}
							disabled={!canManage || update.isPending}
							onSave={(value) =>
								update.mutate({
									tediId,
									toolPolicy: JSON.parse(value.toolPolicyJson) as ToolPolicy,
									selfImprovementPolicy: JSON.parse(
										value.learningPolicyJson,
									) as SelfImprovementPolicy,
									budgets: JSON.parse(value.budgetsJson) as TediBudgets,
									quietHours: JSON.parse(value.quietHoursJson) as QuietHours,
								})
							}
						/>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Devices</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<Collection aria-label="Devices">
							{[
								...(devices.data?.pending ?? []),
								...(devices.data?.paired ?? []),
							].map((device) => (
								<SettingsRecordRow
									key={device.id}
									title={
										<>
											<Text role="body" weight="medium">
												{device.displayName ?? device.id}
											</Text>
											<Badge variant="outline">{device.status}</Badge>
										</>
									}
									trailing={
										<Button
											size="sm"
											variant="outline"
											disabled={!canManage || deviceAction.isPending}
											onClick={() =>
												deviceAction.mutate({
													id: device.id,
													action:
														device.status === "pending" ? "approve" : "revoke",
												})
											}
										>
											{device.status === "pending" ? "Approve" : "Revoke"}
										</Button>
									}
								/>
							))}
						</Collection>
						{(devices.data?.pending.length ?? 0) +
							(devices.data?.paired.length ?? 0) ===
						0 ? (
							<Text role="body" tone="secondary">
								No observed devices.
							</Text>
						) : null}
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle>Custom domains</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						<Text role="body" tone="secondary">
							Adding a hostname creates a pending Tedix record only. DNS and
							certificate provisioning are separate steps.
						</Text>
						<CustomDomainForm
							disabled={!canManage || addDomain.isPending}
							onSave={(value) =>
								addDomain
									.mutateAsync(value)
									.then(() => true)
									.catch(() => false)
							}
						/>
						<Collection aria-label="Custom domains">
							{(domains.data?.data ?? []).map((domain) => (
								<SettingsRecordRow
									key={domain.id}
									title={
										<>
											<Text role="body" weight="medium">
												{domain.hostname}
											</Text>
											<Badge variant="outline">
												{domain.status ?? "pending"}
											</Badge>
										</>
									}
									trailing={
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={`Remove ${domain.hostname}`}
											disabled={!canDelete || removeDomain.isPending}
											title={
												!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined
											}
											onClick={() => removeDomain.mutate(domain.id)}
											icon={<Trash className="size-4" />}
										></Button>
									}
								/>
							))}
						</Collection>
					</CardContent>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Lifecycle</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-3">
					<Button
						variant="outline"
						disabled={!canManage || rotateAccessKey.isPending}
						onClick={() =>
							requireRotateStepUp((token) => rotateAccessKey.mutate(token))
						}
					>
						Rotate identity access key
					</Button>
					<Button
						variant="outline"
						disabled={!canDelete || resetSandbox.isPending}
						title={!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined}
						onClick={() => {
							resetSandbox.reset();
							setResetOpen(true);
						}}
					>
						Reset workstation sandbox
					</Button>
					<ConfirmDialog
						open={resetOpen}
						onOpenChange={setResetOpen}
						title="Reset this workstation sandbox?"
						description="This non-force recovery destroys the current workstation sandbox and is blocked unless a healthy backup exists. It does not force a reset or delete the tedi's cognitive history."
						confirmLabel="Reset safely"
						pendingLabel="Resetting…"
						destructive
						isPending={resetSandbox.isPending}
						error={resetSandbox.error}
						onConfirm={() => resetSandbox.mutate()}
					/>
					<Button
						variant="destructive"
						disabled={!canDelete || retire.isPending}
						title={!canDelete ? TEDIS_DELETE_DENIED_REASON : undefined}
						onClick={() => {
							retire.reset();
							setRetireOpen(true);
						}}
					>
						Retire Tedi
					</Button>
					<ConfirmDialog
						open={retireOpen}
						onOpenChange={setRetireOpen}
						title="Retire this tedi?"
						description="The worker identity and runtime stop immediately. Memory, rationale, skills, artifacts, growth history, and audit evidence remain retained."
						confirmLabel="Retire tedi"
						pendingLabel="Retiring…"
						destructive
						isPending={retire.isPending}
						error={retire.error}
						onConfirm={() => retire.mutate()}
					/>
				</CardContent>
			</Card>
			<RotateStepUpDialog />
		</div>
	);
}
