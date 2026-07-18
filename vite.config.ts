import { defineConfig } from 'vite';

// Build id (ISO čas buildu) — zabuduje se do appky i do version.json,
// aby šlo detekovat, že je venku nová verze. Na CI se vyhodnotí při buildu.
const buildId = new Date().toISOString();

export default defineConfig({
  // Relativní cesty — funguje na GitHub Pages (podadresář) i lokálně.
  base: './',
  build: { target: 'es2022' },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [
    {
      name: 'emit-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId }),
        });
      },
    },
  ],
});
