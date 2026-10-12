<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { modules } from '#lib/jarvis/modules.js';
	import GearSix from 'phosphor-svelte/lib/GearSix';
	import ThemeToggle from './theme-toggle.svelte';

	let { children }: { children: Snippet } = $props();

	const isCurrent = (href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

	// The clock is real data; it only renders on the client so the server never guesses the time.
	let now = $state<Date | null>(null);
	onMount(() => {
		now = new Date();
		const tick = setInterval(() => (now = new Date()), 15_000);
		return () => clearInterval(tick);
	});
	const time = $derived(
		now ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(now) : ''
	);
	const day = $derived(
		now
			? new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(now)
			: ''
	);
</script>

{#snippet mark(className: string)}
	<!-- The Jarvis mark: a ring that listens, a dot that answers. -->
	<svg viewBox="0 0 24 24" aria-hidden="true" class={className}>
		<circle cx="12" cy="12" r="8.25" fill="none" stroke="currentColor" stroke-width="2.5" />
		<circle cx="12" cy="12" r="3" fill="currentColor" />
	</svg>
{/snippet}

{#snippet settings()}
	<!-- Configurações: refaz o onboarding (dependências, modelos, módulos e segredos). -->
	<a
		href="/onboarding?refazer"
		aria-label="Configurações"
		title="Configurações"
		aria-current={page.url.pathname.startsWith('/onboarding') ? 'page' : undefined}
		class="grid size-9 place-items-center rounded-[var(--radius-control)] text-ink-soft transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-ink aria-[current=page]:text-brand"
	>
		<GearSix class="size-[1.125rem]" weight={page.url.pathname.startsWith('/onboarding') ? 'fill' : 'regular'} />
	</a>
{/snippet}

<!--
	Desktop: a sidebar of the second neutral layer. Phone: a slim top bar for the wordmark and theme,
	and the modules in a tab bar under the thumb. Two navs, never both displayed, so each layout keeps
	its own landmark without the sticky header becoming the containing block of the fixed tab bar.
-->
<div class="min-h-dvh md:grid md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)]">
	<aside
		class="sticky top-0 hidden h-dvh flex-col border-r border-rule bg-chrome px-3 pt-5 pb-4 md:flex"
	>
		<a
			href="/"
			class="group flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5"
			aria-label="Jarvis, início"
		>
			{@render mark('size-[1.375rem] text-brand transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] group-hover:rotate-90')}
			<span class="display text-[1.1875rem] leading-none text-ink">Jarvis</span>
		</a>

		<nav aria-label="Módulos" class="mt-7 flex-1">
			<ul class="grid gap-0.5">
				{#each modules as module (module.id)}
					{@const current = isCurrent(module.href)}
					<li>
						<a
							href={module.href}
							aria-current={current ? 'page' : undefined}
							class={[
								'group flex h-9 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-[0.875rem] font-medium',
								'transition-[background-color,color,box-shadow,scale] duration-[var(--dur-fast)] ease-[var(--ease-out)] active:scale-[0.98]',
								current
									? 'bg-raised text-ink shadow-[0_0_0_1px_var(--rule),var(--shadow-xs)]'
									: 'text-ink-soft hover:bg-hover hover:text-ink'
							]}
						>
							<module.icon
								class={`size-[1.125rem] shrink-0 ${current ? 'text-brand' : 'text-ink-faint group-hover:text-ink-soft'}`}
								weight={current ? 'fill' : 'regular'}
							/>
							<span class="min-w-0 flex-1 truncate">{module.label}</span>
						</a>
					</li>
				{/each}
			</ul>
		</nav>

		<div class="flex items-end justify-between gap-2 border-t border-rule px-1 pt-3.5">
			<div class="min-w-0 px-1.5">
				{#if now}
					<p class="tabular display text-[1.375rem] leading-none text-ink">{time}</p>
					<p class="mt-1.5 truncate text-micro text-ink-soft first-letter:uppercase">{day}</p>
				{:else}
					<p class="text-[1.375rem] leading-none text-transparent select-none">00:00</p>
					<p class="mt-1.5 text-micro text-transparent select-none">—</p>
				{/if}
			</div>
			<div class="flex items-center">
				{@render settings()}
				<ThemeToggle />
			</div>
		</div>
	</aside>

	<header
		class="sticky top-0 z-20 flex h-[calc(3.25rem+env(safe-area-inset-top))] items-center justify-between gap-3 border-b border-rule bg-chrome pt-[env(safe-area-inset-top)] pr-[max(var(--gutter),env(safe-area-inset-right))] pl-[max(var(--gutter),env(safe-area-inset-left))] md:hidden"
	>
		<a href="/" class="flex items-center gap-2" aria-label="Jarvis, início">
			{@render mark('size-5 text-brand')}
			<span class="display text-[1.0625rem] leading-none text-ink">Jarvis</span>
		</a>
		<div class="flex items-center gap-1">
			{#if now}
				<span class="tabular text-meta font-medium text-ink-soft">{time}</span>
			{/if}
			{@render settings()}
			<ThemeToggle />
		</div>
	</header>

	<main
		class="min-w-0 pr-[max(var(--gutter),env(safe-area-inset-right))] pl-[max(var(--gutter),env(safe-area-inset-left))] pt-6 pb-[calc(var(--tabbar-height)+2rem+env(safe-area-inset-bottom))] md:pt-10 md:pb-16"
	>
		<div class="mx-auto w-full max-w-[var(--content-max)]">
			{@render children()}
		</div>
	</main>

	<nav
		aria-label="Módulos"
		class="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-chrome pb-[env(safe-area-inset-bottom)] md:hidden"
	>
		<ul
			class="mx-auto grid h-[var(--tabbar-height)] max-w-lg"
			style:grid-template-columns="repeat({modules.length}, minmax(0, 1fr))"
		>
			{#each modules as module (module.id)}
				{@const current = isCurrent(module.href)}
				<li class="min-w-0">
					<a
						href={module.href}
						aria-current={current ? 'page' : undefined}
						class={[
							'flex h-full min-w-0 flex-col items-center justify-center gap-1 px-1 text-micro font-semibold transition-colors duration-[var(--dur-fast)]',
							current ? 'text-ink' : 'text-ink-soft active:text-ink'
						]}
					>
						<span
							class={[
								'grid h-7 w-12 place-items-center rounded-full transition-[background-color,scale] duration-[var(--dur-base)] ease-[var(--ease-out)]',
								current ? 'bg-brand-soft text-brand' : 'scale-95'
							]}
						>
							<module.icon class="size-5" weight={current ? 'fill' : 'regular'} />
						</span>
						<span class="max-w-full truncate">{module.label}</span>
					</a>
				</li>
			{/each}
		</ul>
	</nav>
</div>
