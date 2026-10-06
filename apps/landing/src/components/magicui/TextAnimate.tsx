"use client";

import type React from "react";
import { memo } from "react";
import {
	AnimatePresence,
	motion,
	type Variants,
	type MotionProps,
} from "motion/react";
import { cn } from "@/lib/utils";

type AnimationType = "text" | "word" | "character" | "line";
type AnimationVariant =
	| "fadeIn"
	| "blurIn"
	| "blurInUp"
	| "blurInDown"
	| "slideUp"
	| "slideDown"
	| "slideLeft"
	| "slideRight";

interface TextAnimateProps extends Omit<MotionProps, "children"> {
	children: React.ReactNode;
	className?: string;
	segmentClassName?: string;
	delay?: number;
	duration?: number;
	variants?: Variants;
	by?: AnimationType;
	startOnView?: boolean;
	once?: boolean;
	animation?: AnimationVariant;
}

/** Recursively extract plain text from React children (handles Astro SSR slots) */
function extractText(node: React.ReactNode): string {
	if (typeof node === "string") return node;
	if (typeof node === "number") return String(node);
	if (node == null || typeof node === "boolean") return "";
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (typeof node === "object" && "props" in node) {
		return extractText(
			(node as React.ReactElement<{ children?: React.ReactNode }>).props
				.children,
		);
	}
	return "";
}

const defaultContainerVariants = {
	hidden: { opacity: 1 },
	show: {
		opacity: 1,
		transition: { delayChildren: 0, staggerChildren: 0.05 },
	},
	exit: {
		opacity: 0,
		transition: { staggerChildren: 0.05, staggerDirection: -1 },
	},
};

const animationVariants: Record<
	AnimationVariant,
	{ container: Variants; item: Variants }
> = {
	fadeIn: {
		container: defaultContainerVariants,
		item: {
			hidden: { opacity: 0, y: 20 },
			show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
			exit: { opacity: 0, y: 20, transition: { duration: 0.3 } },
		},
	},
	blurIn: {
		container: defaultContainerVariants,
		item: {
			hidden: { opacity: 0, filter: "blur(10px)" },
			show: {
				opacity: 1,
				filter: "blur(0px)",
				transition: { duration: 0.3 },
			},
			exit: {
				opacity: 0,
				filter: "blur(10px)",
				transition: { duration: 0.3 },
			},
		},
	},
	blurInUp: {
		container: defaultContainerVariants,
		item: {
			hidden: { opacity: 0, filter: "blur(10px)", y: 20 },
			show: {
				opacity: 1,
				filter: "blur(0px)",
				y: 0,
				transition: { duration: 0.3 },
			},
			exit: {
				opacity: 0,
				filter: "blur(10px)",
				y: 20,
				transition: { duration: 0.3 },
			},
		},
	},
	blurInDown: {
		container: defaultContainerVariants,
		item: {
			hidden: { opacity: 0, filter: "blur(10px)", y: -20 },
			show: {
				opacity: 1,
				filter: "blur(0px)",
				y: 0,
				transition: { duration: 0.3 },
			},
		},
	},
	slideUp: {
		container: defaultContainerVariants,
		item: {
			hidden: { y: 20, opacity: 0 },
			show: { y: 0, opacity: 1, transition: { duration: 0.3 } },
			exit: { y: -20, opacity: 0, transition: { duration: 0.3 } },
		},
	},
	slideDown: {
		container: defaultContainerVariants,
		item: {
			hidden: { y: -20, opacity: 0 },
			show: { y: 0, opacity: 1, transition: { duration: 0.3 } },
			exit: { y: 20, opacity: 0, transition: { duration: 0.3 } },
		},
	},
	slideLeft: {
		container: defaultContainerVariants,
		item: {
			hidden: { x: 20, opacity: 0 },
			show: { x: 0, opacity: 1, transition: { duration: 0.3 } },
			exit: { x: -20, opacity: 0, transition: { duration: 0.3 } },
		},
	},
	slideRight: {
		container: defaultContainerVariants,
		item: {
			hidden: { x: -20, opacity: 0 },
			show: { x: 0, opacity: 1, transition: { duration: 0.3 } },
			exit: { x: 20, opacity: 0, transition: { duration: 0.3 } },
		},
	},
};

function TextAnimateBase({
	children,
	delay = 0,
	duration = 0.3,
	variants,
	className,
	segmentClassName,
	startOnView = true,
	once = true,
	by = "word",
	animation = "fadeIn",
	...props
}: TextAnimateProps) {
	const text = extractText(children);
	let segments: string[];
	switch (by) {
		case "word":
			segments = text.split(/(\s+)/);
			break;
		case "character":
			segments = text.split("");
			break;
		case "line":
			segments = text.split("\n");
			break;
		case "text":
		default:
			segments = [text];
			break;
	}

	const finalVariants = variants
		? {
				container: {
					hidden: { opacity: 0 },
					show: {
						opacity: 1,
						transition: {
							opacity: { duration: 0.01, delay },
							delayChildren: delay,
							staggerChildren: duration / segments.length,
						},
					},
					exit: {
						opacity: 0,
						transition: {
							staggerChildren: duration / segments.length,
							staggerDirection: -1,
						},
					},
				},
				item: variants,
			}
		: {
				container: {
					...animationVariants[animation].container,
					show: {
						...animationVariants[animation].container.show,
						transition: {
							delayChildren: delay,
							staggerChildren: duration / segments.length,
						},
					},
				},
				item: animationVariants[animation].item,
			};

	return (
		<AnimatePresence mode="popLayout">
			<motion.p
				variants={finalVariants.container as Variants}
				initial="hidden"
				whileInView={startOnView ? "show" : undefined}
				animate={startOnView ? undefined : "show"}
				exit="exit"
				className={cn("whitespace-pre-wrap", className)}
				viewport={{ once }}
				{...props}
			>
				{segments.map((segment, i) => (
					<motion.span
						key={`${by}-${segment}-${i}`}
						variants={finalVariants.item}
						className={cn(
							by === "line" ? "block" : "inline-block whitespace-pre",
							segmentClassName,
						)}
					>
						{segment}
					</motion.span>
				))}
			</motion.p>
		</AnimatePresence>
	);
}

export const TextAnimate = memo(TextAnimateBase);
