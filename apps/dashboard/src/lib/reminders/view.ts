/** How the reminders are read: by deadline or by list. */
export type Grouping = 'prazo' | 'lista';

/** Everything the screen shows lives in the URL, so a view can be bookmarked and reloaded as is. */
export type View = {
	readonly list: string | null;
	readonly includeCompleted: boolean;
	readonly group: Grouping;
};

export const groupingFrom = (params: Pick<URLSearchParams, 'get'>): Grouping => (params.get('agrupar') === 'lista' ? 'lista' : 'prazo');

export const viewHref = (view: View) => {
	const params = new URLSearchParams();
	if (view.list !== null) params.set('lista', view.list);
	if (view.includeCompleted) params.set('concluidos', '1');
	if (view.group === 'lista') params.set('agrupar', 'lista');
	const query = params.toString();
	return query === '' ? '/lembretes' : `/lembretes?${query}`;
};

// Case and accents never decide a match: "reuniao" finds "Reunião".
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('pt-BR');

/** A predicate for the search box: every word typed must appear in the title, the notes or the list name. */
export const matcher = (query: string) => {
	const words = fold(query).split(/\s+/).filter((word) => word !== '');
	if (words.length === 0) return () => true;
	return (item: { readonly title: string; readonly notes?: string | undefined; readonly list: string }) => {
		const haystack = fold(`${item.title}\n${item.notes ?? ''}\n${item.list}`);
		return words.every((word) => haystack.includes(word));
	};
};
