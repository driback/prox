import { createFactory } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { processResponseBody } from './hls.utils';

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
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const requestHeaders = new Headers();
    const range = c.req.header('range');
    const userAgent = c.req.header('user-agent');
    
    if (range) requestHeaders.set('Range', range);
    requestHeaders.set('User-Agent', userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    requestHeaders.set('Referer', targetUrl.origin);

    const upstream = await fetch(targetUrl.href, { 
      signal: controller.signal,
      headers: requestHeaders,
      redirect: 'follow', 
    });
    
    clearTimeout(timeout);

    if (!upstream.ok) {
      return c.text(
        upstream.statusText,
        upstream.status as ContentfulStatusCode
      );
    }

    const finalUrl = upstream.url || targetUrl.href;
    const upstreamType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    
    const isM3u8 = finalUrl.includes('.m3u8') || 
                   (upstreamType && /application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(upstreamType));

    const contentType = upstreamType || (isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t');

    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range', 
      'Content-Disposition': 'inline',
      'Accept-Ranges': 'bytes',
      'Vary': 'Origin, Range',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });

    ['Content-Range', 'Last-Modified', 'ETag'].forEach(key => {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    });

    const upstreamEncoding = upstream.headers.get('Content-Encoding');
    const upstreamLen = upstream.headers.get('Content-Length');
    
    if (!isM3u8 && upstreamLen && !upstreamEncoding) {
      headers.set('Content-Length', upstreamLen);
    }

    const stream = processResponseBody(upstream, contentType, finalUrl);

    return new Response(stream, {
      status: upstream.status as 200 | 206,
      headers,
    });

  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Timeout', 504);
    }
    return c.text('Proxy Error', 502);
  }
});