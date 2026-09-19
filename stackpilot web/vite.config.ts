import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3005,
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      'motion/react': 'framer-motion',
      'motion': 'framer-motion',
    },
  },
  optimizeDeps: {
    include: ['gsap', 'gsap/ScrollTrigger', 'lenis', 'ogl', 'framer-motion'],
  },
});
