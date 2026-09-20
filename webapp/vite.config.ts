import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// In development the device is reached through the Vite proxy so the app is same-origin.
// Point it elsewhere with:  OPENFLEXITO_DEVICE=http://192.168.1.50 npm run dev
const device = process.env.OPENFLEXITO_DEVICE ?? 'http://microscope.local'

export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/ws': { target: device, ws: true, changeOrigin: true },
      '/rpc': { target: device, changeOrigin: true },
      '/health': { target: device, changeOrigin: true },
      '/stream.mjpg': { target: device, changeOrigin: true },
      '/stream-lores.mjpg': { target: device, changeOrigin: true },
      '/snapshot.jpg': { target: device, changeOrigin: true },
      '/raw.bin': { target: device, changeOrigin: true },
      // Without these two the SPA fallback answers with index.html and the callers fail deep in the
      // parser ("not an openflexito bracket") instead of at the fetch: keep in step with the device's
      // routes in device/openflexito/web.py.
      '/flat.bin': { target: device, changeOrigin: true },
      '/bracket.bin': { target: device, changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: false },
})
