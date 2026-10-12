import { isLocalRequest } from '#lib/server/onboarding/loopback.js';
import { onboardingState } from '#lib/server/onboarding/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ getClientAddress, request, url }) => {
	if (!isLocalRequest(getClientAddress(), request.headers)) return { local: false as const };
	return { local: true as const, refazer: url.searchParams.has('refazer'), estado: onboardingState() };
};
