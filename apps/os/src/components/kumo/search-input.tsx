import { MagnifyingGlass } from "@phosphor-icons/react";
import { InputGroup as KumoInputGroup } from "@cloudflare/kumo/components/input-group";
import {
	forwardRef,
	type ComponentPropsWithoutRef,
	type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

type SearchInputProps = Omit<
	ComponentPropsWithoutRef<typeof KumoInputGroup.Input>,
	"type"
> & {
	containerClassName?: string;
	trailing?: ReactNode;
};

function SearchInputTrailingContent({ children }: { children: ReactNode }) {
	return <>{children}</>;
}

const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
	function SearchInput(
		{ className, containerClassName, trailing, ...props },
		ref,
	) {
		return (
			<KumoInputGroup
				data-kumo-component="SearchInput"
				size="base"
				className={cn(
					"h-9 rounded-lg type-tedix-body shadow-none max-sm:h-auto max-sm:min-h-11 coarse:h-auto coarse:min-h-11",
					containerClassName,
				)}
			>
				<KumoInputGroup.Addon>
					<MagnifyingGlass aria-hidden="true" />
				</KumoInputGroup.Addon>
				<KumoInputGroup.Input
					ref={ref}
					type="search"
					className={cn("type-tedix-body", className)}
					{...props}
				/>
				{trailing ? (
					<KumoInputGroup.Addon align="end" className="gap-2 pr-1.5">
						<SearchInputTrailingContent>{trailing}</SearchInputTrailingContent>
					</KumoInputGroup.Addon>
				) : null}
			</KumoInputGroup>
		);
	},
);

export { SearchInput, type SearchInputProps };
