import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { answerProxyFailure, proxyFailure, proxyTarget } from './dev-proxy';

const apiTarget = proxyTarget();

/**
 * The proxy the console is served through, for both `vite` (dev) and `vite preview` (built).
 *
 * The `error` handler is the reason this object is built here rather than inline: without it a
 * stopped API reaches the browser as a `500` with no body at all, which the console can only
 * report as "HTTP 500: empty body" (see `dev-proxy.ts`).
 */
const apiProxy: ProxyOptions = {
  target: apiTarget,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('error', (error, _request, response) => {
      answerProxyFailure(response, proxyFailure(apiTarget, error));
    });
  },
};

const proxy = { '/api': apiProxy };

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy,
     allowedHosts: [
    "frp-few.com",
  ],
  },
  // `vite preview` serves the production bundle; without the same proxy the built
  // console would receive index.html for every /api call instead of the real API.
  preview: {
    proxy,
  },
  
});
