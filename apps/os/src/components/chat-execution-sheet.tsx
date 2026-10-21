import { Info, X } from "@phosphor-icons/react";
import {
	createContext,
	lazy,
	Suspense,
	useContext,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { Button } from "@/components/kumo/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/kumo/sheet";
import { Skeleton } from "@/components/kumo/skeleton";
import { HomeRunIdentity } from "@/components/home-run-identity";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/kumo/tooltip";
import { useMediaQuery } from "@/lib/use-media-query";

const ExecutionDetails = lazy(async () => {
	const module = await import("@/components/home-execution-detail");
	return { default: module.HomeExecutionDetailPage };
});
const DetailsContext = createContext<
	((runId: string, trigger: HTMLElement) => void) | null
>(null);

function ChatExecutionSheet({
	runId,
	branchId,
	onClose,
	trigger,
}: {
	runId?: string;
	branchId?: string;
	onClose: () => void;
	trigger?: HTMLElement | null;
}) {
	const mobile = useMediaQuery("(max-width: 639px)");
	return (
		<Sheet
			open={Boolean(runId)}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<SheetContent
				side={mobile ? "bottom" : "right"}
				size="md"
				showCloseButton={false}
				className={mobile ? "max-h-[85dvh] rounded-t-xl" : "sm:w-full"}
				finalFocus={trigger ? () => trigger : undefined}
			>
				<SheetHeader className="flex-row items-start justify-between gap-4">
					<div className="grid min-w-0 gap-2">
						<SheetTitle>Response details</SheetTitle>
						<SheetDescription>
							What happened during this response.
						</SheetDescription>
						{runId ? <HomeRunIdentity runId={runId} /> : null}
					</div>
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label="Close"
									icon={<X size={16} />}
									onClick={onClose}
								/>
							}
						/>
						<TooltipContent>Close</TooltipContent>
					</Tooltip>
				</SheetHeader>
				{runId ? (
					<Suspense fallback={<Skeleton className="mx-4 h-32 sm:mx-6" />}>
						<ExecutionDetails runId={runId} branchId={branchId} embedded />
					</Suspense>
				) : null}
			</SheetContent>
		</Sheet>
	);
}

export function ChatExecutionDetailsProvider({
	runId,
	branchId,
	onOpen,
	onClose,
	children,
}: {
	runId?: string;
	branchId?: string;
	onOpen: (runId: string) => void;
	onClose: () => void;
	children: ReactNode;
}) {
	const trigger = useRef<HTMLElement | null>(null);
	return (
		<DetailsContext.Provider
			value={(id, element) => {
				trigger.current = element;
				onOpen(id);
			}}
		>
			{children}
			<ChatExecutionSheet
				runId={runId}
				branchId={branchId}
				onClose={onClose}
				trigger={trigger.current}
			/>
		</DetailsContext.Provider>
	);
}

export function ChatExecutionDetailsButton({ runId }: { runId: string }) {
	const openDetails = useContext(DetailsContext);
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement | null>(null);
	return (
		<>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							ref={trigger}
							type="button"
							aria-label="Details"
							aria-haspopup="dialog"
							variant="ghost"
							size="icon-sm"
							icon={<Info size={16} />}
							onClick={(event) => {
								if (openDetails) openDetails(runId, event.currentTarget);
								else setOpen(true);
							}}
						/>
					}
				/>
				<TooltipContent>Details</TooltipContent>
			</Tooltip>
			{!openDetails && open ? (
				<ChatExecutionSheet
					runId={runId}
					onClose={() => setOpen(false)}
					trigger={trigger.current}
				/>
			) : null}
		</>
	);
}
