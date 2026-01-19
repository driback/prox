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

  const isPlaylistRequest = targetUrl.pathname.endsWith('.m3u8');
  const controller = new AbortController();

  let timeout: NodeJS.Timeout | undefined;
  if (!isPlaylistRequest) {
    timeout = setTimeout(() => controller.abort(), 30_000);
  }

  try {
    const requestHeaders = new Headers();
    const range = c.req.header('range');
    const ifRange = c.req.header('if-range');
    const userAgent = c.req.header('user-agent');

    if (range) requestHeaders.set('Range', range);
    if (ifRange) requestHeaders.set('If-Range', ifRange);
    if (userAgent) requestHeaders.set('User-Agent', userAgent);

    requestHeaders.set('Referer', targetUrl.origin);

    const upstream = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: requestHeaders,
      redirect: 'follow',
    });

    if (timeout) clearTimeout(timeout);

    const finalUrl = upstream.url || targetUrl.href;
    let contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

    const isM3u8 =
      finalUrl.includes('.m3u8') ||
      (contentType && /mpegurl/i.test(contentType));

    if (!contentType) {
      contentType = isM3u8
        ? 'application/vnd.apple.mpegurl'
        : 'video/mp2t';
    }

    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Content-Disposition': 'inline',
      'Vary': 'Origin, Range',
    });

    if (isM3u8) {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
      headers.set('Pragma', 'no-cache');
    } else {
      headers.set('Accept-Ranges', 'bytes');
    }

    for (const key of ['Content-Range', 'Last-Modified', 'ETag']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    if (!isM3u8 && upstream.status === 200) {
      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
    }

    const stream = processResponseBody(upstream, contentType, finalUrl);

    return new Response(stream, {
      status: upstream.status as 200 | 206,
      headers,
    });

  } catch (err) {
    if (timeout) clearTimeout(timeout);
    console.error('Media HLS Proxy Error:', err);

    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Upstream timeout', 504);
    }

    return c.text('Proxy Error', 502);
  }
});
