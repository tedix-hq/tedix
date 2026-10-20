import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	WorkExecutorSchema,
	type WorkExecutor,
	type WorkItem,
} from "@tedix/api-contract/schemas/work-items";
import { Button } from "@/components/kumo/button";
import { Label } from "@/components/kumo/label";
import { Input } from "@/components/kumo/input";
import { Textarea } from "@/components/kumo/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";

const labels: Record<WorkExecutor, string> = {
	human: "Human",
	tedi: "Tedi",
	codex: "Codex",
	devin: "Devin",
	"claude-code": "Claude Code",
};
function ExecutorChoice({
	value,
	onChange,
	disabled,
	id: providedId,
}: {
	value: WorkExecutor;
	onChange: (value: WorkExecutor) => void;
	disabled?: boolean;
	id?: string;
}) {
	const generatedId = useId();
	const id = providedId ?? generatedId;
	return (
		<>
			<Label htmlFor={id}>Executor</Label>
			<Select
				value={value}
				onValueChange={(next) => onChange(WorkExecutorSchema.parse(next))}
				disabled={disabled}
			>
				<SelectTrigger id={id} aria-label="Executor">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{WorkExecutorSchema.options.map((executor) => (
						<SelectItem key={executor} value={executor}>
							{labels[executor]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</>
	);
}

export function WorkExecutorChoice({ item }: { item: WorkItem }) {
	const client = useQueryClient();
	const viewer = useQuery(userProfileQueryOptions());
	const parsed = WorkExecutorSchema.safeParse(item.metadata?.executor);
	const executor = parsed.success ? parsed.data : "human";
	const localExecutor =
		executor === "codex" || executor === "claude-code" || executor === "devin";
	const attempts = useQuery({
		...osQuery.workItems.listAttempts.queryOptions({
			input: { id: item.id, limit: 1 },
		}),
		enabled: localExecutor,
		refetchInterval: localExecutor ? 10_000 : false,
	});
	const latest = attempts.data?.data[0];
	const active =
		latest &&
		["queued", "running", "waiting", "retrying"].includes(latest.runtimeState);
	const start = useMutation({
		mutationFn: () =>
			osApi.workItems.updateSpecification({
				id: item.id,
				expectedWorkItemVersion: item.version,
				executor,
				laneDispatch: { state: "ready" },
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	const update = useMutation({
		mutationFn: (value: WorkExecutor) =>
			osApi.workItems.updateSpecification({
				id: item.id,
				expectedWorkItemVersion: item.version,
				executor: value,
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	const editable =
		item.accountableOwnerType === "user" &&
		viewer.data?.id === item.accountableOwnerId &&
		["proposed", "accepted"].includes(item.disposition);
	return (
		<div className="grid gap-2">
			<ExecutorChoice
				value={executor}
				onChange={(value) => update.mutate(value)}
				disabled={!editable || update.isPending}
			/>
			{localExecutor ? (
				<>
					<Text tone="secondary">
						The task description is the session brief. A connected Mac starts
						the session when it has capacity.
					</Text>
					{item.disposition === "accepted" && editable ? (
						<Button
							disabled={
								start.isPending ||
								update.isPending ||
								attempts.isPending ||
								attempts.isError ||
								Boolean(active)
							}
							onClick={() => start.mutate()}
						>
							Start session
						</Button>
					) : null}
					{latest ? (
						<Text tone="secondary">
							Attempt {latest.id.slice(0, 8)} · {latest.runtimeState}
							{latest.outcome ? ` · ${latest.outcome}` : ""}
							{latest.heartbeatAt
								? ` · Last update ${new Date(latest.heartbeatAt).toLocaleString()}`
								: ""}
						</Text>
					) : item.metadata?.laneDispatch &&
					  typeof item.metadata.laneDispatch === "object" &&
					  "state" in item.metadata.laneDispatch &&
					  item.metadata.laneDispatch.state === "ready" ? (
						<Text tone="secondary">Waiting for a connected Mac.</Text>
					) : null}
					{attempts.isError ? (
						<Text tone="error">
							Session status is unavailable. Refresh to retry.
						</Text>
					) : null}
					{start.isError ? (
						<Text tone="error">
							Could not start the session. Refresh and retry.
						</Text>
					) : null}
				</>
			) : null}
			{update.isError ? (
				<Text tone="error">
					Could not save the executor. Refresh and retry.
				</Text>
			) : null}
		</div>
	);
}

/** Workspace app: task posting uses the same Work records and admission as every other surface. */
export function WorkDispatchApp({ projectId }: { projectId: string }) {
	const client = useQueryClient();
	const viewer = useQuery(userProfileQueryOptions());
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [executor, setExecutor] = useState<WorkExecutor>("human");
	const items = useQuery(
		osQuery.workItems.list.queryOptions({
			input: { projectId, limit: 50, offset: 0 },
		}),
	);
	const create = useMutation({
		mutationFn: () => {
			if (!viewer.data?.id) throw new Error("Your profile is unavailable");
			return osApi.workItems.create({
				title: title.trim(),
				description,
				executor,
				projectId,
				accountableOwnerType: "user",
				accountableOwnerId: viewer.data.id,
			});
		},
		onSuccess: async () => {
			setTitle("");
			setDescription("");
			await client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			});
		},
	});
	const accept = useMutation({
		mutationFn: (item: WorkItem) =>
			osApi.workItems.accept({
				id: item.id,
				acceptanceContract: {
					version: 1,
					doneLooksLike: item.title,
				},
			}),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: osQuery.workItems.key({ type: "query" }),
			}),
	});
	return (
		<div className="grid gap-6">
			<form
				className="grid gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate();
				}}
			>
				<Text as="h2" weight="semibold">
					Post a task
				</Text>
				<Input
					aria-label="Task"
					placeholder="What needs doing?"
					value={title}
					maxLength={500}
					onChange={(event) => setTitle(event.target.value)}
				/>
				<Textarea
					aria-label="Description"
					placeholder="Describe the result you want."
					value={description}
					maxLength={10000}
					onChange={(event) => setDescription(event.target.value)}
				/>
				<ExecutorChoice
					id="work-executor"
					value={executor}
					onChange={setExecutor}
				/>
				<Button
					type="submit"
					disabled={!title.trim() || create.isPending || !viewer.data?.id}
				>
					Post task
				</Button>
				<Text tone="secondary">
					Accept a posted task to make it available to its executor. Codex and
					Claude Code start when a connected Mac has capacity.
				</Text>
				{create.isError ? (
					<Text tone="error">
						Could not post the task. Your text is kept here.
					</Text>
				) : null}
			</form>
			{items.isError ? (
				<Text tone="error">Work is unavailable. Refresh to retry.</Text>
			) : null}
			{(items.data?.data ?? []).map((item) => (
				<section
					key={item.id}
					className="grid gap-3 border-t border-kumo-line pt-4"
				>
					<Text as="h3" weight="semibold">
						{item.title}
					</Text>
					<Text>{item.description}</Text>
					<Text tone="secondary">{item.disposition}</Text>
					<WorkExecutorChoice item={item} />
					{item.disposition === "proposed" &&
					item.accountableOwnerId === viewer.data?.id ? (
						<Button
							disabled={accept.isPending}
							onClick={() => accept.mutate(item)}
						>
							Accept task
						</Button>
					) : null}
				</section>
			))}
			{accept.isError ? (
				<Text tone="error">Could not accept the task. It remains posted.</Text>
			) : null}
		</div>
	);
}
