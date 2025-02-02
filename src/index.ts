import { Hono } from 'hono';
import { every } from 'hono/combine';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { HlsController } from './modules/hls/hls.controller';
import { MediaController } from './modules/media/media.controller';

const app = new Hono();

app.use(
  '*',
  every(
    cors({
      origin: '*',
      allowMethods: ['GET'],
      allowHeaders: ['Content-Type'],
    }),
    secureHeaders({
      strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
      xFrameOptions: 'DENY',
      xXssProtection: '1',
    })
  )
);

app.get('/', (c) => c.text('Hono!'));
app.get('/media', ...MediaController);
app.get('/hls', ...HlsController);

app.options('/', (c) => {
  return c.body(null, 204);
});

export default app;
