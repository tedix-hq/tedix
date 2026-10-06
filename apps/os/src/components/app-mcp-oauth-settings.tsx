/**
 * MCP OAuth Settings. Manages OAuth/auth configuration for an app's MCP server:
 *
 * - Auth mode (public / authenticated / hybrid / proxy-target)
 * - Tedi assignment policy (manual vs profile-default materialization)
 * - Descope resource registration status
 * - Per-tool scope requirements
 * - Scope descriptions for the consent screen
 *
 * Everything writes through one `apps.update` of `metadata.mcpConfig`; the
 * save invalidates the apps domain so the layout header, Overview, and
 * Content readers of the same app record all converge.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useStore } from "@tanstack/react-form";
import type { AppMetadata, AppTool } from "@tedix/api-contract/schemas/app";
import {
	getMcpAppAssignmentConfig,
	type McpAppAssignmentConfig,
} from "@tedix/auth/app-assignment-policy";
import {
	CAPABILITY_PROFILES,
	type McpCapabilityProfile,
} from "@tedix/mcp-shared/auth/scopes";
import {
	CheckCircle,
	LockSimple,
	Plus,
	ShieldCheck,
	Trash,
	X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo } from "react";
import { isImeComposing } from "@/lib/keyboard";
import { Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { KumoSelect } from "@/components/kumo/select";
import { Separator } from "@/components/kumo/separator";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";

// =============================================================================
// TYPES
// =============================================================================

type AssignmentConfigState = Required<McpAppAssignmentConfig>;
type AuthMode = "public" | "authenticated" | "hybrid" | "proxy-target";
type AssignmentMode = AssignmentConfigState["mode"];
type AssignmentRole = AssignmentConfigState["role"];

interface McpOAuthFormValues {
	authMode: AuthMode;
	toolScopes: Record<string, string[]>;
	scopeDescriptions: Record<string, string>;
	toolAuthRequirements: Record<
		string,
		{ authRequired: boolean; scopes?: string[] }
	>;
	assignmentConfig: AssignmentConfigState;
	newScopeInputs: Record<string, string>;
	newScopeKey: string;
	newScopeDesc: string;
}

const AUTH_MODE_ITEMS: Array<{ label: string; value: AuthMode }> = [
	{ label: "Public", value: "public" },
	{ label: "Authenticated", value: "authenticated" },
	{ label: "Hybrid per-tool auth", value: "hybrid" },
	{ label: "Proxy target auth", value: "proxy-target" },
];

const ASSIGNMENT_MODE_ITEMS: Array<{ label: string; value: AssignmentMode }> = [
	{ label: "Manual only", value: "manual" },
	{ label: "Profile default", value: "profile-default" },
];

const ASSIGNMENT_ROLE_ITEMS: Array<{ label: string; value: AssignmentRole }> = [
	{ label: "Operator", value: "operator" },
	{ label: "Observer", value: "observer" },
];

interface McpOAuthSettingsProps {
	appId: string;
	mcpConfig?: AppMetadata["mcpConfig"];
	tools?: Array<Pick<AppTool, "id" | "toolId" | "title" | "enabled">>;
	metadata?: AppMetadata | null;
	/** Mirrors the server's `apps:update` gate; false renders read-only. */
	canManage?: boolean;
}

const CAPABILITY_PROFILE_OPTIONS = Object.keys(
	CAPABILITY_PROFILES,
) as McpCapabilityProfile[];

function normalizeAssignmentConfig(
	mcpConfig: AppMetadata["mcpConfig"] | undefined,
): AssignmentConfigState {
	return getMcpAppAssignmentConfig(mcpConfig);
}

function oauthFormValues(
	mcpConfig: AppMetadata["mcpConfig"] | undefined,
): McpOAuthFormValues {
	return {
		authMode: mcpConfig?.authMode ?? "public",
		toolScopes: mcpConfig?.toolScopes ?? {},
		scopeDescriptions: mcpConfig?.scopeDescriptions ?? {},
		toolAuthRequirements: mcpConfig?.toolAuthRequirements ?? {},
		assignmentConfig: normalizeAssignmentConfig(mcpConfig),
		newScopeInputs: {},
		newScopeKey: "",
		newScopeDesc: "",
	};
}

function parseDelimitedList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function formatDelimitedList(values: string[] | undefined): string {
	return (values ?? []).join(", ");
}

// =============================================================================
// COMPONENT
// =============================================================================

export function McpOAuthSettings({
	appId,
	mcpConfig,
	tools,
	metadata,
	canManage = true,
}: McpOAuthSettingsProps) {
	const queryClient = useQueryClient();
	const updateMutation = useMutation({
		mutationFn: (input: Parameters<typeof osApi.apps.update>[0]) =>
			osApi.apps.update(input),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: osQueryKeys.apps() });
		},
	});
	const defaultValues = useMemo(() => oauthFormValues(mcpConfig), [mcpConfig]);
	const form = useForm({
		defaultValues,
		onSubmit: ({ value }) => {
			const updatedMcpConfig = {
				...mcpConfig,
				authMode: value.authMode,
				capabilities: mcpConfig?.capabilities ?? [],
				enforcePolicies: mcpConfig?.enforcePolicies ?? false,
				toolScopes: value.toolScopes,
				scopeDescriptions: value.scopeDescriptions,
				toolAuthRequirements: value.toolAuthRequirements,
				assignmentConfig: value.assignmentConfig,
			};
			updateMutation.mutate({
				appId,
				metadata: { ...metadata, mcpConfig: updatedMcpConfig },
			});
		},
	});
	const values = useStore(form.store, (state) => state.values);
	const isDirty = useStore(form.store, (state) => state.isDirty);
	const {
		authMode,
		toolScopes,
		scopeDescriptions,
		toolAuthRequirements,
		assignmentConfig,
		newScopeInputs,
		newScopeKey,
		newScopeDesc,
	} = values;

	// Sync from props when they change (e.g., after refetch)
	useEffect(() => {
		form.reset(oauthFormValues(mcpConfig));
	}, [form, mcpConfig]);

	// =========================================================================
	// MUTATION
	// =========================================================================

	// =========================================================================
	// HANDLERS
	// =========================================================================

	const handleAuthModeChange = useCallback(
		(value: string | null) => {
			if (
				value !== "public" &&
				value !== "authenticated" &&
				value !== "hybrid" &&
				value !== "proxy-target"
			) {
				return;
			}
			form.setFieldValue("authMode", value);
		},
		[form],
	);

	const handleToolAuthToggle = useCallback(
		(toolId: string, required: boolean) => {
			form.setFieldValue("toolAuthRequirements", (prev) => ({
				...prev,
				[toolId]: {
					...prev[toolId],
					authRequired: required,
					scopes: prev[toolId]?.scopes ?? [],
				},
			}));
		},
		[form],
	);

	const handleAddToolScope = useCallback(
		(toolId: string) => {
			const scope = (newScopeInputs[toolId] ?? "").trim();
			if (!scope) return;

			form.setFieldValue("toolScopes", (prev) => {
				const existing = prev[toolId] ?? [];
				if (existing.includes(scope)) return prev;
				return { ...prev, [toolId]: [...existing, scope] };
			});
			form.setFieldValue("newScopeInputs", (prev) => ({
				...prev,
				[toolId]: "",
			}));
		},
		[form, newScopeInputs],
	);

	const handleRemoveToolScope = useCallback(
		(toolId: string, scope: string) => {
			form.setFieldValue("toolScopes", (prev) => ({
				...prev,
				[toolId]: (prev[toolId] ?? []).filter((entry) => entry !== scope),
			}));
		},
		[form],
	);

	const handleAddScopeDescription = useCallback(() => {
		const key = newScopeKey.trim();
		const desc = newScopeDesc.trim();
		if (!key || !desc) return;

		form.setFieldValue("scopeDescriptions", (prev) => ({
			...prev,
			[key]: desc,
		}));
		form.setFieldValue("newScopeKey", "");
		form.setFieldValue("newScopeDesc", "");
	}, [form, newScopeKey, newScopeDesc]);

	const handleRemoveScopeDescription = useCallback(
		(key: string) => {
			form.setFieldValue("scopeDescriptions", (prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		},
		[form],
	);

	const handleScopeDescriptionChange = useCallback(
		(key: string, value: string) => {
			form.setFieldValue("scopeDescriptions", (prev) => ({
				...prev,
				[key]: value,
			}));
		},
		[form],
	);

	const handleAssignmentModeChange = useCallback(
		(value: string | null) => {
			form.setFieldValue("assignmentConfig", (prev) => ({
				...prev,
				mode: value === "profile-default" ? "profile-default" : "manual",
			}));
		},
		[form],
	);

	const handleAssignmentRoleChange = useCallback(
		(value: string | null) => {
			form.setFieldValue("assignmentConfig", (prev) => ({
				...prev,
				role: value === "observer" ? "observer" : "operator",
			}));
		},
		[form],
	);

	const handleCapabilityProfileToggle = useCallback(
		(profile: McpCapabilityProfile, checked: boolean) => {
			form.setFieldValue("assignmentConfig", (prev) => {
				const profiles = new Set(prev.capabilityProfiles);
				if (checked) {
					profiles.add(profile);
				} else {
					profiles.delete(profile);
				}
				return {
					...prev,
					capabilityProfiles: [...profiles],
				};
			});
		},
		[form],
	);

	const handleAssignmentTagsChange = useCallback(
		(field: "requiredTediTags" | "excludedTediTags", value: string) => {
			form.setFieldValue("assignmentConfig", (prev) => ({
				...prev,
				[field]: parseDelimitedList(value),
			}));
		},
		[form],
	);

	// =========================================================================
	// DERIVED
	// =========================================================================

	const usesOAuth = authMode === "authenticated" || authMode === "hybrid";
	const isManagedAssignment = assignmentConfig.mode === "profile-default";
	const hasDescopeRegistration = Boolean(mcpConfig?.descopeResourceId);
	const enabledTools = tools?.filter((tool) => Boolean(tool.enabled)) ?? [];
	const authModeDescription =
		authMode === "authenticated"
			? "Every tool requires an OAuth token."
			: authMode === "hybrid"
				? "Authentication requirements are configured per tool."
				: authMode === "proxy-target"
					? "Authentication is delegated to the upstream proxy target."
					: "Tools are publicly accessible without authentication.";

	// Collect all unique scopes from toolScopes
	const allScopes = new Set<string>();
	for (const scopes of Object.values(toolScopes)) {
		for (const scope of scopes) {
			allScopes.add(scope);
		}
	}

	// =========================================================================
	// RENDER
	// =========================================================================

	return (
		<div className="space-y-6">
			{/* Auth Mode Card */}
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<ShieldCheck size={16} aria-hidden />
						MCP Authentication Mode
					</CardTitle>
					<CardDescription>
						Control whether your MCP server requires OAuth authentication for
						tool access.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<KumoSelect<AuthMode>
						label="Authentication mode"
						description={authModeDescription}
						className="w-full"
						disabled={!canManage}
						items={AUTH_MODE_ITEMS}
						onValueChange={handleAuthModeChange}
						value={authMode}
					/>

					<div className="flex items-center gap-2">
						<Badge
							variant={usesOAuth ? "success" : "secondary"}
							className="gap-1"
						>
							{usesOAuth ? (
								<LockSimple size={12} aria-hidden />
							) : (
								<ShieldCheck size={12} aria-hidden />
							)}
							{authMode === "proxy-target"
								? "Proxy target"
								: authMode === "hybrid"
									? "Hybrid"
									: authMode === "authenticated"
										? "Authenticated"
										: "Public"}
						</Badge>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<ShieldCheck size={16} aria-hidden />
						Tedi Assignment Policy
					</CardTitle>
					<CardDescription>
						Control whether Tedix assigns this MCP app manually or materializes
						it automatically for matching tedi capability profiles and tags.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-4 md:grid-cols-2">
						<KumoSelect<AssignmentMode>
							label="Assignment mode"
							description="Manual mode relies on explicit app-to-tedi assignments. Profile default mode materializes assignments from tedi profiles and tags."
							className="w-full"
							disabled={!canManage}
							items={ASSIGNMENT_MODE_ITEMS}
							onValueChange={handleAssignmentModeChange}
							value={assignmentConfig.mode}
						/>

						<KumoSelect<AssignmentRole>
							label="Granted role"
							description="Operator grants are runtime-capable. Observer grants stay visible for governance and review."
							className="w-full"
							disabled={!canManage}
							items={ASSIGNMENT_ROLE_ITEMS}
							onValueChange={handleAssignmentRoleChange}
							value={assignmentConfig.role}
						/>
					</div>

					<Surface className="p-4">
						<div className="flex items-start justify-between gap-3">
							<div className="space-y-1">
								<Text as="p" role="body" weight="medium" className="m-0">
									Eligible capability profiles
								</Text>
								<Text as="p" role="label" tone="secondary" className="m-0">
									Leave every profile unchecked to match all tedi capability
									profiles in managed mode.
								</Text>
							</div>
							<Badge variant={isManagedAssignment ? "default" : "secondary"}>
								{isManagedAssignment ? "Managed" : "Manual"}
							</Badge>
						</div>

						<div className="mt-4 space-y-3">
							{CAPABILITY_PROFILE_OPTIONS.map((profile) => {
								const enabled =
									assignmentConfig.capabilityProfiles.includes(profile);

								return (
									<Surface
										key={profile}
										className="flex items-center justify-between gap-4 p-3"
									>
										<div className="min-w-0 flex-1 space-y-1">
											<Text as="p" role="body" weight="medium" className="m-0">
												{profile}
											</Text>
											<Text
												as="p"
												role="label"
												tone="secondary"
												className="m-0"
											>
												{CAPABILITY_PROFILES[profile].join(", ")}
											</Text>
										</div>
										<Switch
											className="shrink-0"
											aria-label={`${enabled ? "Exclude" : "Include"} ${profile} capability profile`}
											checked={enabled}
											onCheckedChange={(checked) =>
												handleCapabilityProfileToggle(profile, checked)
											}
											disabled={!canManage || !isManagedAssignment}
										/>
									</Surface>
								);
							})}
						</div>
					</Surface>

					<div className="grid gap-4 md:grid-cols-2">
						<Input
							label="Required tedi tags"
							description="Comma-separated tags. Matching tedis must include every tag."
							value={formatDelimitedList(assignmentConfig.requiredTediTags)}
							onChange={(event) =>
								handleAssignmentTagsChange(
									"requiredTediTags",
									event.target.value,
								)
							}
							placeholder="platform, remote"
							disabled={!canManage || !isManagedAssignment}
						/>

						<Input
							label="Excluded tedi tags"
							description="Comma-separated tags. Any match prevents managed assignment."
							value={formatDelimitedList(assignmentConfig.excludedTediTags)}
							onChange={(event) =>
								handleAssignmentTagsChange(
									"excludedTediTags",
									event.target.value,
								)
							}
							placeholder="disabled, internal"
							disabled={!canManage || !isManagedAssignment}
						/>
					</div>
				</CardContent>
			</Card>

			{/* Registration Status Card */}
			{usesOAuth && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<CheckCircle size={16} aria-hidden />
							Descope Registration
						</CardTitle>
						<CardDescription>
							Registration status with Descope as an OAuth 2.0 resource server.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="flex items-center justify-between">
							<div className="space-y-1">
								<Text as="p" role="body" weight="medium" className="m-0">
									Registration Status
								</Text>
								<Text as="p" role="label" tone="secondary" className="m-0">
									{hasDescopeRegistration
										? "OAuth 2.0 authorization is set up for this MCP server."
										: "OAuth 2.0 authorization is not yet set up for this MCP server. It is required for authenticated mode."}
								</Text>
							</div>
							<Badge
								variant={hasDescopeRegistration ? "default" : "destructive"}
								className="gap-1"
							>
								{hasDescopeRegistration ? (
									<>
										<CheckCircle size={12} aria-hidden />
										Registered
									</>
								) : (
									"Not Registered"
								)}
							</Badge>
						</div>

						{hasDescopeRegistration && mcpConfig?.descopeResourceId && (
							<div className="rounded-md bg-kumo-fill p-3">
								<Text as="p" role="label" tone="secondary" className="m-0">
									Resource ID
								</Text>
								<Text
									as="code"
									role="label"
									tone="mono"
									className="mt-0.5 block rounded bg-kumo-tint px-2 py-1"
								>
									{mcpConfig.descopeResourceId}
								</Text>
							</div>
						)}

						{hasDescopeRegistration && mcpConfig?.expectedAudience && (
							<div className="rounded-md bg-kumo-fill p-3">
								<Text as="p" role="label" tone="secondary" className="m-0">
									Expected Audience
								</Text>
								<Text
									as="code"
									role="label"
									tone="mono"
									className="mt-0.5 block rounded bg-kumo-tint px-2 py-1"
								>
									{mcpConfig.expectedAudience}
								</Text>
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{/* Tool Auth Requirements Card */}
			{usesOAuth && enabledTools.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<LockSimple size={16} aria-hidden />
							Per-Tool Auth Requirements
						</CardTitle>
						<CardDescription>
							Configure which tools require authentication and their scope
							requirements. Tools not listed here will follow the server-level
							auth mode.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Table scrollLabel="Per-tool auth requirements">
							<TableHeader>
								<TableRow>
									<TableHead className="w-[200px]">Tool</TableHead>
									<TableHead className="w-[120px]">Auth Required</TableHead>
									<TableHead>Required Scopes</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{enabledTools.map((tool) => {
									const toolAuth = toolAuthRequirements[tool.toolId];
									const scopes = toolScopes[tool.toolId] ?? [];
									const inputValue = newScopeInputs[tool.toolId] ?? "";

									return (
										<TableRow key={tool.id}>
											<TableCell className="font-medium">
												{tool.title}
												<Text
													as="p"
													role="label"
													tone="mono-secondary"
													className="m-0"
												>
													{tool.toolId}
												</Text>
											</TableCell>
											<TableCell>
												<Switch
													aria-label={`${(toolAuth?.authRequired ?? true) ? "Disable" : "Require"} authentication for ${tool.title}`}
													checked={toolAuth?.authRequired ?? true}
													onCheckedChange={(checked) =>
														handleToolAuthToggle(tool.toolId, checked)
													}
													disabled={!canManage}
												/>
											</TableCell>
											<TableCell>
												<div className="space-y-2">
													<div className="flex flex-wrap gap-1">
														{scopes.map((scope) => (
															<Badge
																key={scope}
																variant="secondary"
																className="gap-1 pr-1"
															>
																{scope}
																<Button
																	variant="ghost"
																	size="icon-xs"
																	aria-label={`Remove ${scope} scope`}
																	type="button"
																	disabled={!canManage}
																	onClick={() =>
																		handleRemoveToolScope(tool.toolId, scope)
																	}
																	className="ml-0.5 rounded-full"
																	icon={<X size={10} aria-hidden />}
																/>
															</Badge>
														))}
													</div>
													<div className="flex items-center gap-1.5">
														<Input
															aria-label={`New scope for ${tool.title}`}
															value={inputValue}
															disabled={!canManage}
															onChange={(event) =>
																form.setFieldValue(
																	"newScopeInputs",
																	(prev) => ({
																		...prev,
																		[tool.toolId]: event.target.value,
																	}),
																)
															}
															onKeyDown={(event) => {
																if (
																	event.key === "Enter" &&
																	!isImeComposing(event)
																) {
																	event.preventDefault();
																	handleAddToolScope(tool.toolId);
																}
															}}
															placeholder="e.g., read:data"
															size="sm"
														/>
														<Button
															type="button"
															aria-label={`Add scope to ${tool.title}`}
															variant="ghost"
															size="icon-sm"
															disabled={!canManage}
															onClick={() => handleAddToolScope(tool.toolId)}
															icon={<Plus size={14} aria-hidden />}
														/>
													</div>
												</div>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{/* Scope Descriptions Card */}
			{usesOAuth && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<ShieldCheck size={16} aria-hidden />
							Scope Descriptions
						</CardTitle>
						<CardDescription>
							Human-readable descriptions for each scope, shown in the OAuth
							consent screen when users authorize access.
						</CardDescription>
					</CardHeader>
					<CardContent className="space-y-4">
						{Object.entries(scopeDescriptions).length > 0 && (
							<div className="space-y-2">
								{Object.entries(scopeDescriptions).map(([key, desc]) => (
									<Surface key={key} className="flex items-start gap-2 p-3">
										<div className="min-w-0 flex-1">
											<Input
												label={key}
												value={desc}
												disabled={!canManage}
												onChange={(event) =>
													handleScopeDescriptionChange(key, event.target.value)
												}
												size="sm"
											/>
										</div>
										<Button
											type="button"
											aria-label={`Remove description for ${key}`}
											variant="ghost"
											size="icon-sm"
											className="mt-5 text-kumo-danger hover:text-kumo-danger"
											disabled={!canManage}
											onClick={() => handleRemoveScopeDescription(key)}
											icon={<Trash size={14} aria-hidden />}
										/>
									</Surface>
								))}
							</div>
						)}

						<Separator />

						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault();
								handleAddScopeDescription();
							}}
						>
							<Text as="p" role="body" weight="medium" className="m-0">
								Add Scope Description
							</Text>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div>
									<Input
										label="Scope"
										value={newScopeKey}
										disabled={!canManage}
										onChange={(event) =>
											form.setFieldValue("newScopeKey", event.target.value)
										}
										placeholder="e.g., read:data"
										size="sm"
									/>
								</div>
								<div className="min-w-0 flex-1">
									<Input
										label="Description"
										value={newScopeDesc}
										disabled={!canManage}
										onChange={(event) =>
											form.setFieldValue("newScopeDesc", event.target.value)
										}
										placeholder="e.g., Read your account data"
										size="sm"
										onKeyDown={(event) => {
											if (event.key === "Enter" && !isImeComposing(event)) {
												event.preventDefault();
												handleAddScopeDescription();
											}
										}}
									/>
								</div>
								<Button
									type="submit"
									variant="outline"
									size="sm"
									disabled={
										!canManage || !newScopeKey.trim() || !newScopeDesc.trim()
									}
									icon={<Plus size={14} aria-hidden />}
								>
									Add
								</Button>
							</div>
						</form>

						{allScopes.size > 0 &&
							Object.keys(scopeDescriptions).length === 0 && (
								<Alert variant="warning">
									<AlertDescription>
										You have scopes configured on tools but no descriptions. Add
										descriptions so users understand what they are authorizing.
									</AlertDescription>
								</Alert>
							)}
					</CardContent>
				</Card>
			)}

			{/* Save Button */}
			{isDirty && (
				<div className="flex items-center justify-end gap-3">
					<Button
						variant="ghost"
						onClick={() => {
							form.reset(oauthFormValues(mcpConfig));
						}}
					>
						Discard Changes
					</Button>
					<Button
						onClick={() => void form.handleSubmit()}
						disabled={!canManage || updateMutation.isPending}
						loading={updateMutation.isPending}
					>
						Save MCP Settings
					</Button>
				</div>
			)}

			{updateMutation.isError && (
				<Alert variant="destructive">
					<AlertDescription>
						Failed to save: {updateMutation.error?.message ?? "Unknown error"}
					</AlertDescription>
				</Alert>
			)}

			{updateMutation.isSuccess && !isDirty && (
				<Alert>
					<AlertDescription role="status" className="text-kumo-success">
						MCP settings saved successfully.
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
