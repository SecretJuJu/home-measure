import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Vite rejects requests whose Host it does not know; a tunnel needs its domain listed to
    // reach the dev server from a real iPad.
    allowedHosts: [".ngrok-free.app", ".ngrok-free.dev", ".ngrok.app", ".ngrok.io"],
  },
});
