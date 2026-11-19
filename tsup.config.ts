import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/redis.ts', 'src/express.ts', 'src/fastify.ts', 'src/fetch.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Keep 'node:crypto' as is: Deno and Cloudflare Workers need the prefix.
  removeNodeProtocol: false,
});
