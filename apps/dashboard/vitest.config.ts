import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Testes do onboarding (detecção, config, plists, downloads). Os demais testes do dashboard rodam no bun:test.
const lib = fileURLToPath(new URL('./src/lib/', import.meta.url));

export default defineConfig({
	resolve: { alias: [{ find: /^#lib\/(.*)\.js$/, replacement: `${lib}$1.ts` }] },
	test: { include: ['test/onboarding/**/*.test.ts'], environment: 'node' }
});
