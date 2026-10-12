/**
 * Follows a promise streamed from `load`. The last answer stays on screen while the next one is read,
 * so refreshing or filtering dims what is there instead of flashing skeletons. Call it during component
 * init: it owns an effect.
 */
export class Latest<T> {
	value = $state<T>();
	pending = $state(true);

	constructor(source: () => Promise<T>) {
		$effect(() => {
			const promise = source();
			let current = true;
			this.pending = true;
			promise.then(
				(value) => {
					if (!current) return;
					this.value = value;
					this.pending = false;
				},
				() => {
					if (current) this.pending = false;
				}
			);
			return () => {
				current = false;
			};
		});
	}
}
