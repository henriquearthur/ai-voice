<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "#lib/utils.js";
	import type { HTMLTextareaAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "textarea",
		...restProps
	}: WithoutChildren<WithElementRef<HTMLTextareaAttributes>> = $props();
</script>

<textarea
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		"flex field-sizing-content min-h-20 w-full rounded-[var(--radius-control)] border border-input bg-raised px-3 py-2.5 text-[0.9375rem] text-ink shadow-xs outline-none transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-ink-faint hover:not-disabled:not-focus-visible:border-ink-faint focus-visible:border-brand focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_20%,transparent)] aria-invalid:border-alert disabled:cursor-not-allowed disabled:opacity-50",
		className
	)}
	bind:value
	{...restProps}></textarea>
