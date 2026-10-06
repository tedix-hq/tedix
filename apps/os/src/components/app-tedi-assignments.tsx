/**
 * Assigned tedis for an app, with assign/unassign/role controls. Reads sit on the generated
 * `tediAppAssignments.listByApp` and shared tedi-roster entries; unassignment
 * is optimistic on the exact generated key. The server's `AUTHZ.tedisRead`
 * guard admits any member here, so no extra client gate is mirrored.
 */

import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { TediAppAssignmentRole } from "@tedix/api-contract/schemas/tedi-app-assignments";
import { Plus, Robot, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import * as z from "zod";
import { FormSelect } from "@/components/forms/form-select";
import { toast } from "@/components/kumo/toast";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/kumo/alert-dialog";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty, EmptyDescription } from "@/components/kumo/empty";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/kumo/dialog";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { osApi } from "@/lib/api";
import {
	osQueryKeys,
	TEDI_ROSTER_LIMIT,
	tediAppAssignmentsByAppQueryOptions,
	tediRosterQueryOptions,
} from "@/lib/os-query-options";
import { absoluteDate } from "@/lib/time";

function parseAssignmentRole(value: string | null): TediAppAssignmentRole {
	return value === "observer" ? "observer" : "operator";
}

const assignmentSchema = z.object({
	tediId: z.uuid("Select a tedi."),
	role: z.enum(["operator", "observer"]),
});

export function AppTediAssignments({ appId }: { appId: string }) {
	const queryClient = useQueryClient();
	const [assignDialogOpen, setAssignDialogOpen] = useState(false);

	const listKey = tediAppAssignmentsByAppQueryOptions(appId).queryKey;

	const {
		data: assignmentsData,
		isLoading: assignmentsLoading,
		isPlaceholderData: assignmentsStale,
		error: assignmentsError,
	} = useQuery({
		...tediAppAssignmentsByAppQueryOptions(appId),
		staleTime: 30_000,
		enabled: appId.length > 0,
		placeholderData: keepPreviousData,
	});

	const {
		data: tedisData,
		isLoading: tedisLoading,
		error: tedisError,
	} = useQuery({
		...tediRosterQueryOptions(TEDI_ROSTER_LIMIT),
		staleTime: 60_000,
	});

	const createAssignment = useMutation({
		mutationFn: (input: {
			appId: string;
			tediId: string;
			role: TediAppAssignmentRole;
		}) => osApi.tediAppAssignments.create(input),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appTediAssignments(),
			});
			setAssignDialogOpen(false);
			assignmentForm.reset();
			toast.success("Tedi assigned to app");
		},
		onError: (error) => {
			toast.error(error.message || "Failed to assign tedi");
		},
	});
	const assignmentForm = useZodForm({
		schema: assignmentSchema,
		defaultValues: { tediId: "", role: "operator" },
		onSubmit: ({ value }) => createAssignment.mutate({ appId, ...value }),
	});

	const deleteAssignment = useMutation({
		mutationFn: (input: { assignmentId: string }) =>
			osApi.tediAppAssignments.delete(input),
		onMutate: async (vars) => {
			await queryClient.cancelQueries({
				queryKey: osQueryKeys.appTediAssignments(),
			});
			const previous = queryClient.getQueryData(listKey);
			queryClient.setQueryData(listKey, (old) =>
				old
					? {
							...old,
							data: old.data.filter((row) => row.id !== vars.assignmentId),
						}
					: old,
			);
			return { previous };
		},
		onError: (_error, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(listKey, context.previous);
			}
			toast.error("Failed to unassign tedi");
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appTediAssignments(),
			});
		},
		onSuccess: () => {
			toast.success("Tedi unassigned from app");
		},
	});

	const updateRole = useMutation({
		mutationFn: (input: {
			assignmentId: string;
			role: TediAppAssignmentRole;
		}) => osApi.tediAppAssignments.updateRole(input),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.appTediAssignments(),
			});
			toast.success("Assignment role updated");
		},
		onError: (error) => {
			toast.error(error.message || "Failed to update role");
		},
	});

	const assignments = assignmentsData?.data ?? [];
	const allTedis = tedisData?.data ?? [];

	// Filter out already-assigned tedis from the dropdown
	const assignedTediIds = new Set(assignments.map((a) => a.tediId));
	const availableTedis = allTedis.filter(
		(tedi) => !assignedTediIds.has(tedi.id),
	);
	const assignmentsUnavailable =
		assignmentsLoading || assignmentsStale || Boolean(assignmentsError);

	const tediNameMap = new Map(allTedis.map((tedi) => [tedi.id, tedi.name]));

	return (
		<Card>
			<CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<CardTitle className="flex items-center gap-2">
						<Robot size={18} aria-hidden />
						Assigned tedis
					</CardTitle>
					<CardDescription>
						Tedis operating or observing this app
					</CardDescription>
				</div>
				<Dialog open={assignDialogOpen} onOpenChange={setAssignDialogOpen}>
					<DialogTrigger
						render={
							<Button
								size="sm"
								disabled={
									assignmentsUnavailable ||
									tedisLoading ||
									Boolean(tedisError) ||
									availableTedis.length === 0
								}
								icon={<Plus size={14} />}
							/>
						}
					>
						Assign tedi
					</DialogTrigger>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Assign tedi to app</DialogTitle>
							<DialogDescription>
								Select a tedi and role to assign to this app.
							</DialogDescription>
						</DialogHeader>
						<form
							className="space-y-4 py-4"
							onSubmit={(event) => {
								event.preventDefault();
								void assignmentForm.handleSubmit();
							}}
						>
							<FormField form={assignmentForm} name="tediId" label="Tedi">
								{(field, meta) => (
									<FormSelect
										field={field}
										{...meta}
										placeholder="Select a tedi..."
									>
										{tedisLoading ? (
											<div className="p-2">
												<Skeleton className="h-4 w-32" />
											</div>
										) : availableTedis.length === 0 ? (
											<div className="p-2 text-kumo-subtle text-sm">
												No available tedis
											</div>
										) : (
											availableTedis.map((tedi) => (
												<SelectItem key={tedi.id} value={tedi.id}>
													{tedi.name}
												</SelectItem>
											))
										)}
									</FormSelect>
								)}
							</FormField>
							<FormField form={assignmentForm} name="role" label="Role">
								{(field, meta) => (
									<FormSelect field={field} {...meta}>
										<SelectItem value="operator">Operator</SelectItem>
										<SelectItem value="observer">Observer</SelectItem>
									</FormSelect>
								)}
							</FormField>
							<DialogFooter>
								<Button
									type="button"
									variant="outline"
									onClick={() => setAssignDialogOpen(false)}
								>
									Cancel
								</Button>
								<Button
									type="submit"
									disabled={
										assignmentsUnavailable ||
										tedisLoading ||
										Boolean(tedisError) ||
										createAssignment.isPending
									}
								>
									{createAssignment.isPending ? "Assigning..." : "Assign"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>
			</CardHeader>
			<CardContent>
				{assignmentsLoading || assignmentsStale ? (
					<div className="space-y-3">
						{[1, 2].map((row) => (
							<div key={row} className="flex items-center gap-4">
								<Skeleton className="h-4 w-32" />
								<Skeleton className="h-4 w-20" />
								<Skeleton className="h-4 w-16" />
							</div>
						))}
					</div>
				) : assignmentsError ? (
					<div className="space-y-3 py-4 text-center">
						<p role="alert" className="m-0 text-kumo-danger text-sm">
							Failed to load assignments: {assignmentsError.message}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() =>
								queryClient.invalidateQueries({
									queryKey: osQueryKeys.appTediAssignments(),
								})
							}
						>
							Retry
						</Button>
					</div>
				) : assignments.length === 0 ? (
					<Empty appearance="quiet">
						<EmptyDescription>
							No tedis assigned to this app yet.
						</EmptyDescription>
						{tedisError ? (
							<p role="alert" className="m-0 text-kumo-danger text-sm">
								Available tedis could not be loaded.
							</p>
						) : null}
					</Empty>
				) : (
					<div className="space-y-3">
						{tedisError ? (
							<p role="alert" className="m-0 text-kumo-danger text-sm">
								Tedi names could not be loaded. Assignment IDs are shown
								instead.
							</p>
						) : null}
						<Table scrollLabel="Tedi assignments for this app">
							<TableHeader>
								<TableRow>
									<TableHead>Tedi</TableHead>
									<TableHead className="w-32">Role</TableHead>
									<TableHead className="w-40">Assigned</TableHead>
									<TableHead className="w-20 text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{assignments.map((assignment) => (
									<TableRow key={assignment.id}>
										<TableCell className="font-medium">
											{tediNameMap.get(assignment.tediId) ?? assignment.tediId}
										</TableCell>
										<TableCell>
											<Select
												value={assignment.role}
												onValueChange={(role) =>
													updateRole.mutate({
														assignmentId: assignment.id,
														role: parseAssignmentRole(role),
													})
												}
												disabled={
													assignmentsUnavailable || updateRole.isPending
												}
											>
												<SelectTrigger
													aria-label={`Role for ${tediNameMap.get(assignment.tediId) ?? assignment.tediId}`}
													className="w-28"
													size="sm"
												>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													<SelectItem value="operator">
														<Badge variant="default">Operator</Badge>
													</SelectItem>
													<SelectItem value="observer">
														<Badge variant="secondary">Observer</Badge>
													</SelectItem>
												</SelectContent>
											</Select>
										</TableCell>
										<TableCell className="text-kumo-subtle">
											{absoluteDate(assignment.createdAt)}
										</TableCell>
										<TableCell className="text-right">
											<AlertDialog>
												<AlertDialogTrigger
													render={
														<Button
															variant="ghost"
															size="icon-sm"
															aria-label={`Unassign ${tediNameMap.get(assignment.tediId) ?? assignment.tediId}`}
															disabled={
																assignmentsUnavailable ||
																deleteAssignment.isPending
															}
															icon={
																<Trash size={16} className="text-kumo-danger" />
															}
														/>
													}
												/>
												<AlertDialogContent>
													<AlertDialogHeader>
														<AlertDialogTitle>
															Unassign this tedi?
														</AlertDialogTitle>
														<AlertDialogDescription>
															{tediNameMap.get(assignment.tediId) ??
																assignment.tediId}{" "}
															will lose access to this app.
														</AlertDialogDescription>
													</AlertDialogHeader>
													<AlertDialogFooter>
														<AlertDialogCancel>Cancel</AlertDialogCancel>
														<AlertDialogAction
															variant="destructive"
															disabled={deleteAssignment.isPending}
															onClick={() =>
																deleteAssignment.mutate({
																	assignmentId: assignment.id,
																})
															}
														>
															Unassign tedi
														</AlertDialogAction>
													</AlertDialogFooter>
												</AlertDialogContent>
											</AlertDialog>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
