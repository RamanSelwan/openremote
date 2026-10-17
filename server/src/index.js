import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server } from 'socket.io';

import {
  PORT,
  isProduction,
  usingDefaultSecret,
  isAllowedOrigin,
  TRUST_PROXY,
} from './config/env.js';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import { initSocket } from './socket/index.js';

const startedAt = Date.now();
const here = path.dirname(fileURLToPath(import.meta.url));

const corsOrigin = (origin, callback) => {
  // No Origin header = native agent / curl / same-origin navigation.
  if (isAllowedOrigin(origin, undefined)) return callback(null, true);
  return callback(null, false);
};

async function main() {
  const mem = await connectDB(console);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', TRUST_PROXY ? 1 : false);
  app.use(cors({ origin: corsOrigin, credentials: false }));
  app.use(express.json({ limit: '256kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    const dbReady = mongoose.connection.readyState === 1;
    res.setHeader('Cache-Control', 'no-store');
    res.status(dbReady ? 200 : 503).json({
      ok: dbReady,
      db: dbReady ? 'up' : 'down',
      uptime: Math.round((Date.now() - startedAt) / 1000),
      version: process.env.npm_package_version || '0.1.0',
    });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', deviceRoutes);

  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // In production the built React app is served from the same origin.
  const dist = path.resolve(here, '../../client/dist');
  const indexHtml = path.join(dist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(dist, {
        index: false,
        dotfiles: 'ignore',
        etag: true,
        maxAge: isProduction ? '1y' : 0,
        immutable: isProduction,
        setHeaders(res, filePath) {
          // Hashed assets can be cached forever; the SPA shell must not be.
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      })
    );
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(indexHtml);
    });
  }

  const server = http.createServer(app);
  // Small input packets must not wait on Nagle: this is the single cheapest
  // latency win for remote mouse/keyboard traffic.
  server.on('connection', (socket) => socket.setNoDelay(true));

  const io = new Server(server, {
    cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
    // Screen frames are JPEGs that fit comfortably in this budget.
    maxHttpBufferSize: 1024 * 1024,
    // Deflate on already-compressed JPEG is pure CPU + latency.
    perMessageDeflate: false,
    serveClient: false,
    pingInterval: 20000,
    pingTimeout: 15000,
    allowRequest: (req, callback) => {
      callback(null, isAllowedOrigin(req.headers.origin, req.headers.host));
    },
  });
  initSocket(io);

  server.listen(PORT, () => {
    console.log(`[server] ${isProduction ? 'production' : 'development'} on :${PORT}`);
    console.log(
      `[server] websocket ready (allowed origins: ${
        process.env.CLIENT_ORIGIN || 'same-origin only'
      })`
    );
    if (usingDefaultSecret()) {
      console.warn(
        '[server] JWT_SECRET is not set - using an INSECURE dev default. Set it before deploying.'
      );
    }
    console.log(`[server] health check: http://localhost:${PORT}/api/health`);
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down...`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    io.close();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect().catch(() => {});
    if (mem) await mem.stop().catch(() => {});
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (err) => {
  console.error('[server] unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
