import { defineConfig } from "vite";

// Barebones build configuration for the Kiero PWA shell.
// Router codegen, PWA assets and any plugin additions are owned by later
// tickets; this config only proves the pinned Vite/React/TanStack graph
// produces an executable client bundle.
export default defineConfig({
  build: {
    outDir: "dist",
  },
});
