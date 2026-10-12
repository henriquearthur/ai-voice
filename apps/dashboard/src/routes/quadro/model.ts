export const ESTADOS = ['aberto', 'pego', 'feito', 'falhou', 'bloqueado'] as const;
export type Estado = (typeof ESTADOS)[number];
export const ROTULO_ESTADO: Record<Estado, string> = { aberto: 'Abertos', pego: 'Pegos', feito: 'Feitos', falhou: 'Falharam', bloqueado: 'Bloqueados' };
export const TITULO_MAX = 120;
export const BRIEF_MAX = 4000;
export const KIT_MAX = 60;
