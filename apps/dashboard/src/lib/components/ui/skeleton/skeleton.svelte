<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> = $props();
</script>

<div
	bind:this={ref}
	data-slot="skeleton"
	aria-hidden="true"
	class={cn("animate-pulse rounded-[var(--radius-control)] bg-[color-mix(in_oklch,var(--ink)_7%,transparent)]", className)}
	{...restProps}
></div>
