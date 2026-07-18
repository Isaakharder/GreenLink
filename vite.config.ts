import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  test: {
    environment: 'node',
    // supabase/functions/**/mapping.test.ts is included so the Edge
    // Function's pure GolfCourseAPI mapping logic is unit-tested here too;
    // *.deno.test.ts files are Deno-only integration tests (run via
    // `deno test`, not Vitest) and are explicitly excluded.
    include: ['src/**/*.test.ts', 'supabase/functions/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.deno.test.ts'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'GreenLink',
        short_name: 'GreenLink',
        description: 'Golf tournament scoring',
        theme_color: '#1b5e3c',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
    }),
  ],
});
