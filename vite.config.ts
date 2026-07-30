import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// Sello de versión del build. Guardian es UNA sola app, pero el navegador de
// cada usuario puede quedarse con un bundle viejo hasta que recargue (pestaña
// abierta días). Cada sesión reporta este sello y el panel /plataforma muestra
// quién quedó atrás. Formato legible: "2026-07-30 14:05".
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_STAMP),
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
          'vendor-charts': ['recharts'],
          'vendor-xlsx': ['xlsx'],
          // L2: framer-motion (~100 KB) en su propio chunk para que el
          // profiler de bundle pueda aislarlo y para que rutas que no lo
          // usan no paguen el costo eager via vendor-ui.
          'vendor-motion': ['framer-motion'],
          'vendor-ui': ['sonner', 'date-fns'],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
}));
