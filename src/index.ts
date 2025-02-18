import { Hono } from 'hono';
import { HlsController } from './modules/hls/hls.controller';
import { MediaController } from './modules/media/media.controller';

const app = new Hono();

app.get('/', (c) => c.text('Hono!'));
app.get('/media', ...MediaController);
app.get('/hls', ...HlsController);

app.options('/', (c) => {
  return c.body(null, 204);
});

export default app;
