// 렌더러 빌드 (dev-standards §2 — Vite/React). 정적 산출물(dist-web)을 셸이 로드한다.
// 폐쇄망 원칙: 빌드 산출물에 외부 네트워크 참조 금지 (NFR-1) — 전부 로컬 번들.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 셸이 file:// 로 loadFile 한다 — 절대 경로(/assets)는 드라이브 루트로 풀려 흰 화면이 되므로
  // 상대 경로 필수 (2026-08-25 Windows 실기기 실측)
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});
