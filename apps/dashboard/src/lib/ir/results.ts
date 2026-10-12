import type { AppleFailure } from '#lib/apple/failure.js';
import type { MapsMode } from './maps.js';
import type { CallVia } from './phone.js';

/** What the /ir form actions hand back to the page; `panel` says which panel owns the result. */
export type MapsResult = {
	panel: 'maps';
	kind: 'search' | 'directions';
	query?: string;
	to?: string;
	from?: string;
	mode?: MapsMode;
	invalid?: string;
	failure?: AppleFailure;
	opened?: { url: string; at: number };
};

export type PhoneResult = {
	panel: 'phone';
	number: string;
	via: CallVia;
	invalid?: string;
	failure?: AppleFailure;
	review?: true;
	placed?: { display: string; at: number };
};

export type IrResult = MapsResult | PhoneResult | null | undefined;
