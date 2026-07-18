import { defineConfig, devices } from '@playwright/test';

// Local-only e2e suite. Requires a `supabase start` instance running and
// E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_ROLE_KEY set (values printed
// by `supabase start`) -- see e2e/seed.ts. Never points at a real project.
const E2E_SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? 'http://127.0.0.1:54321';
const E2E_SUPABASE_ANON_KEY = process.env.E2E_SUPABASE_ANON_KEY ?? '';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  // Single worker: organizer-finish.spec.ts reseeds its own tournament and
  // overwrites the shared e2e/.seed.json that live-scoring.spec.ts reads --
  // safe sequentially, racy if a second worker touches the file mid-test.
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // Always spawn a fresh server pointed at the local Supabase instance --
    // reusing whatever else might already be on :5173 (e.g. a normal `npm
    // run dev` against the real project in .env) would silently run this
    // suite against the wrong backend.
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: E2E_SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: E2E_SUPABASE_ANON_KEY,
    },
  },
});
