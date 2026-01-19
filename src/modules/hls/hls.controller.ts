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
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const requestHeaders = new Headers();
    const range = c.req.header('range');
    const userAgent = c.req.header('user-agent');
    
    if (range) requestHeaders.set('Range', range);
    if (userAgent) requestHeaders.set('User-Agent', userAgent);

    const upstream = await fetch(targetUrl.href, { 
      signal: controller.signal,
      headers: requestHeaders
    });
    
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

    const isPlaylist = /application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType) 
                    || targetUrl.pathname.endsWith('.m3u8');

    const headers = new Headers({
      'Content-Type': contentType,
      'Content-Disposition': 'inline',
      Vary: 'Origin, Range',
    });

    const passthrough = [
      'Cache-Control',
      'Accept-Ranges',
      'Content-Range',
      'Last-Modified',
      'ETag'
    ];

    for (const key of passthrough) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    if (!isPlaylist) {
      const length = upstream.headers.get('Content-Length');
      if (length) headers.set('Content-Length', length);
    }

    const stream = processResponseBody(upstream, contentType, targetUrl.href);

    return new Response(stream, {
      status: upstream.status as 200 | 206,
      headers,
    });

  } catch (err) {
    clearTimeout(timeout);
    console.error('Media HLS Proxy Error:', err instanceof Error ? err.message : err);

    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Upstream timeout', 504);
    }

    return c.text('Proxy Error', 502);
  }
});
