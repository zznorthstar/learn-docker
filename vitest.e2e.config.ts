import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/e2e/**/*.test.ts'], environment: 'node', testTimeout: 120000, hookTimeout: 240000, fileParallelism: false } });
