import type { Component } from 'svelte';
import CalendarBlank from 'phosphor-svelte/lib/CalendarBlank';
import ChatsCircle from 'phosphor-svelte/lib/ChatsCircle';
import Kanban from 'phosphor-svelte/lib/Kanban';
import ListChecks from 'phosphor-svelte/lib/ListChecks';
import NavigationArrow from 'phosphor-svelte/lib/NavigationArrow';
import Robot from 'phosphor-svelte/lib/Robot';
import Pulse from 'phosphor-svelte/lib/Pulse';
import SpeakerHigh from 'phosphor-svelte/lib/SpeakerHigh';

/** A Jarvis module: one entry in the shell's navigation, one route. Add new modules here. */
export type JarvisModule = {
	readonly id: string;
	readonly label: string;
	readonly href: string;
	readonly icon: Component<{ class?: string; weight?: 'regular' | 'bold' | 'fill' | 'duotone' }>;
};

export const modules: ReadonlyArray<JarvisModule> = [
	{ id: 'alexa', label: 'Voz', href: '/', icon: SpeakerHigh },
	{ id: 'conversa', label: 'Conversa', href: '/conversa', icon: ChatsCircle },
	{ id: 'lembretes', label: 'Lembretes', href: '/lembretes', icon: ListChecks },
	{ id: 'agenda', label: 'Agenda', href: '/agenda', icon: CalendarBlank },
	{ id: 'ir', label: 'Ir & ligar', href: '/ir', icon: NavigationArrow },
	{ id: 'telemetria', label: 'Telemetria', href: '/telemetria', icon: Pulse },
	{ id: 'agentes', label: 'Agentes', href: '/agentes', icon: Robot },
	{ id: 'quadro', label: 'Quadro', href: '/quadro', icon: Kanban }
];
