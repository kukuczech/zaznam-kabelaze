import { defineConfig } from 'vite';

export default defineConfig({
  // Relativní cesty — funguje na GitHub Pages (podadresář) i lokálně.
  base: './',
  build: { target: 'es2022' },
});
