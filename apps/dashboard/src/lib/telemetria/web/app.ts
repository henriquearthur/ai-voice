/** What the Telemetria tab's "App" section shows: the frontend's own numbers, last hour, from Prometheus. */
export type AppWeb = {
	readonly prometheus: 'ok' | 'fora';
	readonly lcpP75: number | null;
	readonly inpP75: number | null;
	readonly navegacaoP75: number | null;
	/** From a live frame arriving to it being painted. */
	readonly atrasoLiveP75: number | null;
	readonly erros: number | null;
	readonly reconexoes: number | null;
	/** Live frames coalesced by the 1 Hz limit or dropped as repeats. */
	readonly descartes: number | null;
	readonly heapBytes: number | null;
	/** Some page reported in the last hour. */
	readonly ativo: boolean;
	readonly geradoEm: number;
};
