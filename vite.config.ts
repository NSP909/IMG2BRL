import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development the browser talks to the Pi through this dev server:
 * requests to /pi/* are forwarded to the solenoid controller. The browser
 * only ever sees localhost, so no local-network permission or CORS is
 * involved. Override the Pi address with PI_HOST=host:port.
 */
const PI = process.env.PI_HOST ?? '169.254.10.10:8080';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    open: false,
    proxy: {
      '/pi': {
        target: `http://${PI}`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/pi/, ''),
      },
    },
  },
});
