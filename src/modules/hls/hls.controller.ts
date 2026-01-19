import { createFactory } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { processResponseBody } from './hls.helper';

const factory = createFactory();

export const HlsController = factory.createHandlers(async (c) => {
  const rawUrl = c.req.query('url');
  if (!rawUrl) return c.text('No URL provided', 400);

  let targetUrl: URL;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return c.text('Invalid URL provided', 400);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const upstream = await fetch(targetUrl.href, { signal: controller.signal });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return c.text(
        `Fetch failed: ${upstream.status} ${upstream.statusText}`,
        upstream.status as ContentfulStatusCode
      );
    }

    const contentType =
      upstream.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() || 'application/vnd.apple.mpegurl';

    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      Vary: 'Origin, Range',
    });

    const passthrough = [
      'Cache-Control',
      'Content-Length',
      'Accept-Ranges',
      'Content-Range',
    ];
    for (const key of passthrough) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    const stream = processResponseBody(upstream, contentType, targetUrl.href);
    return new Response(stream, {
      status: upstream.status === 206 ? 206 : 200,
      headers,
    });
  } catch (err) {
    clearTimeout(timeout);
    console.error('Media HLS Proxy Error:', err);

    const msg = err instanceof Error ? err.message : 'Proxy Error';
    return c.text(msg, 500);
  }
});
