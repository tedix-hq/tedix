"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface ParticlesProps {
	className?: string;
	quantity?: number;
	staticity?: number;
	ease?: number;
	size?: number;
	color?: string;
	vx?: number;
	vy?: number;
}

interface Circle {
	x: number;
	y: number;
	translateX: number;
	translateY: number;
	size: number;
	alpha: number;
	targetAlpha: number;
	dx: number;
	dy: number;
	magnetism: number;
}

function hexToRgb(hex: string): number[] {
	hex = hex.replace("#", "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((c) => c + c)
			.join("");
	}
	const num = Number.parseInt(hex, 16);
	return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

export function Particles({
	className = "",
	quantity = 100,
	staticity = 50,
	ease = 50,
	size = 0.4,
	color = "#ffffff",
	vx = 0,
	vy = 0,
}: ParticlesProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const canvasContainerRef = useRef<HTMLDivElement>(null);
	const context = useRef<CanvasRenderingContext2D | null>(null);
	const circles = useRef<Circle[]>([]);
	const mouse = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
	const canvasSize = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
	const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
	const rafId = useRef<number | null>(null);
	const [rgb, setRgb] = useState(hexToRgb(color));

	useEffect(() => {
		setRgb(hexToRgb(color));
	}, [color]);

	const resizeCanvas = useCallback(() => {
		if (canvasContainerRef.current && canvasRef.current && context.current) {
			circles.current = [];
			canvasSize.current.w = canvasContainerRef.current.offsetWidth;
			canvasSize.current.h = canvasContainerRef.current.offsetHeight;
			canvasRef.current.width = canvasSize.current.w * dpr;
			canvasRef.current.height = canvasSize.current.h * dpr;
			canvasRef.current.style.width = `${canvasSize.current.w}px`;
			canvasRef.current.style.height = `${canvasSize.current.h}px`;
			context.current.setTransform(dpr, 0, 0, dpr, 0, 0);
		}
	}, [dpr]);

	const circleParams = useCallback((): Circle => {
		const x = Math.floor(Math.random() * canvasSize.current.w);
		const y = Math.floor(Math.random() * canvasSize.current.h);
		const pSize = Math.floor(Math.random() * 2) + size;
		const alpha = 0;
		const targetAlpha = Number.parseFloat(
			(Math.random() * 0.6 + 0.1).toFixed(1),
		);
		const dx = (Math.random() - 0.5) * 0.1;
		const dy = (Math.random() - 0.5) * 0.1;
		const magnetism = 0.1 + Math.random() * 4;
		return {
			x,
			y,
			translateX: 0,
			translateY: 0,
			size: pSize,
			alpha,
			targetAlpha,
			dx,
			dy,
			magnetism,
		};
	}, [size]);

	const drawCircle = useCallback(
		(circle: Circle, update = false) => {
			if (context.current) {
				const { x, y, translateX, translateY, size: s, alpha } = circle;
				context.current.translate(translateX, translateY);
				context.current.beginPath();
				context.current.arc(x, y, s, 0, 2 * Math.PI);
				context.current.fillStyle = `rgba(${rgb.join(", ")}, ${alpha})`;
				context.current.fill();
				context.current.setTransform(dpr, 0, 0, dpr, 0, 0);
				if (!update) {
					circles.current.push(circle);
				}
			}
		},
		[dpr, rgb],
	);

	const drawParticles = useCallback(() => {
		circles.current = [];
		for (let i = 0; i < quantity; i++) {
			const circle = circleParams();
			drawCircle(circle);
		}
	}, [circleParams, drawCircle, quantity]);

	const remapValue = useCallback(
		(
			value: number,
			start1: number,
			end1: number,
			start2: number,
			end2: number,
		): number => {
			const remapped =
				((value - start1) * (end2 - start2)) / (end1 - start1) + start2;
			return remapped > 0 ? remapped : 0;
		},
		[],
	);

	const animate = useCallback(() => {
		if (context.current) {
			context.current.clearRect(
				0,
				0,
				canvasSize.current.w,
				canvasSize.current.h,
			);
			for (let i = circles.current.length - 1; i >= 0; i--) {
				const circle = circles.current[i];
				const edge = [
					circle.x + circle.translateX - circle.size,
					canvasSize.current.w - circle.x - circle.translateX - circle.size,
					circle.y + circle.translateY - circle.size,
					canvasSize.current.h - circle.y - circle.translateY - circle.size,
				];
				const closestEdge = edge.reduce((a, b) => Math.min(a, b));
				const remapClosestEdge = remapValue(closestEdge, 0, 20, 0, 1).toFixed(
					2,
				);
				if (Number.parseFloat(remapClosestEdge) > 1) {
					circle.alpha += 0.02;
					if (circle.alpha > circle.targetAlpha)
						circle.alpha = circle.targetAlpha;
				} else {
					circle.alpha =
						circle.targetAlpha * Number.parseFloat(remapClosestEdge);
				}
				circle.x += circle.dx + vx;
				circle.y += circle.dy + vy;
				circle.translateX +=
					(mouse.current.x / (staticity / circle.magnetism) -
						circle.translateX) /
					ease;
				circle.translateY +=
					(mouse.current.y / (staticity / circle.magnetism) -
						circle.translateY) /
					ease;
				drawCircle(circle, true);
				if (
					circle.x < -circle.size ||
					circle.x > canvasSize.current.w + circle.size ||
					circle.y < -circle.size ||
					circle.y > canvasSize.current.h + circle.size
				) {
					circles.current.splice(i, 1);
					const newCircle = circleParams();
					drawCircle(newCircle);
				}
			}
			rafId.current = window.requestAnimationFrame(animate);
		}
	}, [circleParams, drawCircle, ease, remapValue, staticity, vx, vy]);

	useEffect(() => {
		if (canvasRef.current) {
			context.current = canvasRef.current.getContext("2d");
		}
		resizeCanvas();
		drawParticles();
		animate();
		const handleResize = () => {
			resizeCanvas();
			drawParticles();
		};
		const handleMouseMove = (e: MouseEvent) => {
			if (canvasRef.current) {
				const rect = canvasRef.current.getBoundingClientRect();
				const { w, h } = canvasSize.current;
				const x = e.clientX - rect.left - w / 2;
				const y = e.clientY - rect.top - h / 2;
				const inside =
					e.clientX >= rect.left &&
					e.clientX <= rect.right &&
					e.clientY >= rect.top &&
					e.clientY <= rect.bottom;
				if (inside) {
					mouse.current.x = x;
					mouse.current.y = y;
				}
			}
		};
		window.addEventListener("resize", handleResize);
		window.addEventListener("mousemove", handleMouseMove);
		return () => {
			if (rafId.current != null) {
				window.cancelAnimationFrame(rafId.current);
			}
			window.removeEventListener("resize", handleResize);
			window.removeEventListener("mousemove", handleMouseMove);
		};
	}, [animate, drawParticles, resizeCanvas]);

	return (
		<div className={className} ref={canvasContainerRef} aria-hidden="true">
			<canvas ref={canvasRef} className="size-full" />
		</div>
	);
}
