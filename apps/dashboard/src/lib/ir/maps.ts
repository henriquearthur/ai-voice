/** Travel modes the Maps module accepts, shared by the form, the receipt and the server action. */
export const mapsModes = ['driving', 'walking', 'transit'] as const;

export type MapsMode = (typeof mapsModes)[number];

export const mapsModeLabels: Record<MapsMode, string> = {
	driving: 'Carro',
	walking: 'A pé',
	transit: 'Transporte'
};

export const isMapsMode = (value: unknown): value is MapsMode => (mapsModes as readonly unknown[]).includes(value);
