import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';

export function registerSecurityMiddleware(app: Hono<AppEnv>): void {
  app.use('*', async (context, next) => {
    const requestId = context.req.header('CF-Ray') || crypto.randomUUID();
    const startedAt = Date.now();
    context.header('X-Request-ID', requestId);
    try {
      await next();
    } finally {
      console.log(JSON.stringify({
        event: 'http_request',
        request_id: requestId,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        duration_ms: Date.now() - startedAt
      }));
    }
  });

  app.use('*', async (context, next) => {
    await next();
    context.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (new URL(context.req.url).protocol === 'https:') {
      context.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.use('/api/mcp', async (context, next) => {
    const origin = context.req.header('Origin');
    if (origin && origin !== new URL(context.req.url).origin) {
      return context.json({
        jsonrpc: '2.0',
        error: { code: -32003, message: 'Forbidden: untrusted Origin' },
        id: null
      }, 403);
    }
    await next();
  });
}
