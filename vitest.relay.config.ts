import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/relay/**/*.test.ts'], environment: 'node', testTimeout: 60000, hookTimeout: 120000, fileParallelism: false } });
