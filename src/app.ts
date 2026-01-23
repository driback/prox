import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HlsController } from './modules/hls/hls.controller';
import { MediaController } from './modules/media/media.controller';

export const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET'],
    allowHeaders: ['Content-Type'],
  })
);

app.get('/', (c) => c.text('Hono!!'));
app.get('/media', ...MediaController);
app.get('/hls', ...HlsController);

app.options('/', (c) => {
  return c.body(null, 204);
});

