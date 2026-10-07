/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL API absolut untuk staging; kosong → `/api/v1` (proxy Vercel ke production). */
  readonly VITE_API_BASE_URL?: string;
}
