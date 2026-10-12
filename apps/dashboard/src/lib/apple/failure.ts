/**
 * What the browser may learn about a failed call to a macOS app. `permission`: macOS refused Automation
 * (AppleScript -1743/-1744), fixed in System Settings. `timeout`: the app did not answer in time, which on
 * a first visit usually means the macOS consent dialog is still waiting for the user.
 */
export type AppleFailure = {
	readonly kind: 'permission' | 'timeout' | 'automation' | 'unexpected';
	readonly message: string;
};

export type AppleOutcome<A> =
	| { readonly ok: true; readonly value: A }
	| { readonly ok: false; readonly failure: AppleFailure };
