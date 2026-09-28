import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Split the big libraries into their own cacheable chunks.
        manualChunks(id: string) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/postprocessing') || id.includes('node_modules/n8ao')) return 'fx';
          return undefined;
        },
      },
    },
  },
});
