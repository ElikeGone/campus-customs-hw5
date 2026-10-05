import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dashboard calls the FastAPI backend directly at VITE_API_URL (default http://localhost:8000).
// The backend's CORS allows exactly this dev origin, so keep Vite on 5173 and fail loudly
// instead of silently moving to another port the backend would reject.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
