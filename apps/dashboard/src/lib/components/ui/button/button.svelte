<script lang="ts" module>
	import { type VariantProps, tv } from "tailwind-variants";
	import { cn, type WithElementRef } from "#lib/utils.js";
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from "svelte/elements";

	export const buttonVariants = tv({
		base: "group/button relative inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] border border-transparent bg-clip-padding text-sm font-semibold tracking-[0.003em] outline-none select-none transition-[background-color,border-color,color,box-shadow,scale,opacity] duration-[var(--dur-fast)] ease-[var(--ease-out)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:not-aria-[haspopup]:not-disabled:scale-[0.97] aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground shadow-[var(--shadow-sm),inset_0_1px_0_color-mix(in_oklch,var(--raised)_14%,transparent)] hover:not-disabled:bg-[color-mix(in_oklch,var(--primary),var(--raised)_14%)]",
				brand: "bg-brand text-brand-contrast shadow-[var(--shadow-sm),inset_0_1px_0_color-mix(in_oklch,white_18%,transparent)] hover:not-disabled:bg-brand-strong",
				outline: "border-rule-strong bg-raised text-ink shadow-xs hover:not-disabled:border-input hover:not-disabled:bg-accent aria-expanded:bg-accent",
				secondary: "bg-sunken text-ink hover:not-disabled:bg-[color-mix(in_oklch,var(--sunken),var(--ink)_6%)] aria-expanded:bg-[color-mix(in_oklch,var(--sunken),var(--ink)_6%)]",
				ghost: "text-ink-soft hover:not-disabled:bg-hover hover:not-disabled:text-ink aria-expanded:bg-hover aria-expanded:text-ink",
				destructive: "bg-alert-soft text-alert border-alert/25 hover:not-disabled:bg-[color-mix(in_oklch,var(--alert-soft),var(--alert)_10%)] focus-visible:outline-alert",
				link: "h-auto px-0 text-brand underline-offset-4 decoration-brand/40 hover:underline active:not-disabled:scale-100",
			},
			size: {
				default: "h-9 gap-2 px-3.5 pointer-coarse:h-11",
				xs: "h-6 gap-1 rounded-[0.3125rem] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-8 pointer-coarse:h-10 gap-1.5 px-2.5 text-[0.8125rem] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-11 gap-2 px-5 text-[0.9375rem]",
				icon: "size-9 pointer-coarse:size-11",
				"icon-xs": "size-6 rounded-[0.3125rem] [&_svg:not([class*='size-'])]:size-3",
				"icon-sm": "size-8 pointer-coarse:size-10",
				"icon-lg": "size-10",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>["variant"];
	export type ButtonSize = VariantProps<typeof buttonVariants>["size"];

	export type ButtonProps = WithElementRef<HTMLButtonAttributes> &
		WithElementRef<HTMLAnchorAttributes> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
		};
</script>

<script lang="ts">
	let {
		class: className,
		variant = "default",
		size = "default",
		ref = $bindable(null),
		href = undefined,
		type = "button",
		disabled,
		children,
		...restProps
	}: ButtonProps = $props();
</script>

{#if href}
	<a
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		href={disabled ? undefined : href}
		aria-disabled={disabled}
		role={disabled ? "link" : undefined}
		tabindex={disabled ? -1 : undefined}
		{...restProps}
	>
		{@render children?.()}
	</a>
{:else}
	<button
		bind:this={ref}
		data-slot="button"
		class={cn(buttonVariants({ variant, size }), className)}
		{type}
		{disabled}
		{...restProps}
	>
		{@render children?.()}
	</button>
{/if}
