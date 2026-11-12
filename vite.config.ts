import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// InputDeck talks to USB devices through WebHID, which only exists in the browser,
// so the app runs as a single-page app (no server rendering).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  server: { port: 5176, strictPort: true },
  plugins: [tailwindcss(), tanstackStart({ spa: { enabled: true } }), viteReact()],
  test: { include: ['src/**/*.test.ts'] },
} as never)
