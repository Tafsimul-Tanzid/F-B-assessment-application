import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/setup/globalSetup.js'],
    setupFiles: ['./tests/setup/setupFile.js'],
    // Test files share one database, so they must not run in parallel with
    // each other. Within a file, tests still fire genuinely concurrent HTTP
    // requests — that is the point of the concurrency suite.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
