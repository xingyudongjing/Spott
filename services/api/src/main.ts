import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { Http2ServerRequest } from 'node:http2';
import process from 'node:process';
import fastifyRateLimit from '@fastify/rate-limit';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import 'reflect-metadata';
import { AppModule } from './app.module.js';
import { configuration, corsOrigins } from './config.js';
import { APIExceptionFilter } from './platform/http-exception.filter.js';
import type { SpottRequest } from './platform/request-context.js';
import { registerSecurityHeaders } from './platform/security-headers.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = configuration();
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({
    logger: {
      level: config.NODE_ENV === 'development' ? 'debug' : 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-spott-bff-signature',
        'req.headers.x-spott-device-binding',
        'body.code',
        'body.phoneNumber',
        'body.refreshToken',
        'body.deviceBindingProof',
        'body.signedPayload',
        'body.signedTransaction',
        'req.rawBody',
        'rawBody',
      ],
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: (request: IncomingMessage | Http2ServerRequest) => {
      const supplied = request.headers['x-request-id'];
      return typeof supplied === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(supplied)
        ? supplied
        : `req_${randomUUID()}`;
    },
  }),
  { bufferLogs: true, rawBody: true },
);

await registerSecurityHeaders(app.getHttpAdapter().getInstance(), config);
await app.register(fastifyRateLimit, {
  max: 300,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    const rawDevice = request.headers['x-spott-device-id'];
    const device = Array.isArray(rawDevice) ? rawDevice[0] : rawDevice;
    return `${request.ip}:${device ?? 'unknown'}`;
  },
});

app.enableCors({
  origin: corsOrigins(config),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'Idempotency-Key',
    'If-Match',
    'X-Request-Id',
    'X-Spott-Device-Id',
    ...(config.NODE_ENV === 'development' ? ['X-Spott-User-Id', 'X-Spott-Role'] : []),
  ],
});
app.setGlobalPrefix('v1');
app.useGlobalFilters(new APIExceptionFilter());
app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
  (request as SpottRequest).requestId = request.id;
  reply.header('x-request-id', request.id);
  done();
});
app.enableShutdownHooks();

await app.listen(config.PORT, '0.0.0.0');
Logger.log(`Spott API listening on :${config.PORT}`, 'Bootstrap');
