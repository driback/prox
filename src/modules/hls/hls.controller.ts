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

    let contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    
    const isM3u8 = targetUrl.pathname.endsWith('.m3u8') || 
                   (contentType && /application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType));

    if (!contentType) {
      contentType = isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    }

    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'Vary': 'Origin, Range',
    });

    if (isM3u8) {
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      const cacheControl = upstream.headers.get('Cache-Control');
      if (cacheControl) headers.set('Cache-Control', cacheControl);
    }

    const passthrough = ['Content-Range', 'Last-Modified', 'ETag'];
    for (const key of passthrough) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    if (!isM3u8) {
      const contentEncoding = upstream.headers.get('Content-Encoding');
      const contentLength = upstream.headers.get('Content-Length');
      
      if (contentLength && !contentEncoding) {
        headers.set('Content-Length', contentLength);
      }
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
