/**
 * BFF for the web app: shapes core-API predictions into screen view models under /bff/*, and
 * serves the built React app (apps/web/dist) with an SPA fallback, so one origin serves both.
 */
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.ts';

const webDist = process.env.WEB_DIST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const port = Number(process.env.BFF_PORT ?? 3000);

// In production the BFF sits behind Caddy (the only public entry point), so the client address
// comes from X-Forwarded-For; the BFF port itself only listens on localhost / the Docker network.
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ bodyLimit: 64 * 1024, trustProxy: true }),
);
app.enableShutdownHooks();
const fastify = app.getHttpAdapter().getInstance();

// Per-visitor limit so a public site can't swamp the single-core VM. A page load makes a handful of
// requests and the departure board refreshes once a minute, so real use stays far below this.
await fastify.register(fastifyRateLimit, {
  max: Number(process.env.BFF_RATE_LIMIT ?? 240),
  timeWindow: '1 minute',
});

if (existsSync(path.join(webDist, 'index.html'))) {
  await fastify.register(fastifyStatic, { root: webDist, wildcard: false });
  // SPA fallback. Nest owns the not-found handler, so use a catch-all route: exact routes (static
  // files, /bff/*) win over the wildcard, and unknown /bff paths still get a JSON 404.
  fastify.get('/*', (req, reply) => {
    if (req.url.startsWith('/bff/')) return reply.code(404).send({ statusCode: 404, message: 'Not Found' });
    return reply.sendFile('index.html');
  });
} else {
  console.warn(`[bff] no web build at ${webDist}; serving /bff only (use the Vite dev server for the UI)`);
}

await app.listen(port, '0.0.0.0');
console.log(`[bff] listening on :${port}, core API ${process.env.CORE_API_URL ?? 'http://localhost:8080'}`);
