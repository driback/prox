import { createFactory } from 'hono/factory';
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

  // 1. Handle Preflight / Options requests immediately
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization',
      },
    });
  }

  const isPlaylistRequest = targetUrl.pathname.endsWith('.m3u8');
  const controller = new AbortController();

  // Timeout logic: Only for segments, to prevent hanging connections
  let timeout: NodeJS.Timeout | undefined;
  if (!isPlaylistRequest) {
    timeout = setTimeout(() => controller.abort(), 30_000);
  }

  try {
    const requestHeaders = new Headers();
    const range = c.req.header('range');
    
    // Pass vital headers
    if (range) requestHeaders.set('Range', range);
    requestHeaders.set('User-Agent', c.req.header('user-agent') || 'HlsProxy/1.0');
    requestHeaders.set('Referer', targetUrl.origin);

    const upstream = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: requestHeaders,
      redirect: 'follow',
    });

    if (timeout) clearTimeout(timeout);

    // Get the final URL after redirects (crucial for relative path resolution)
    const finalUrl = upstream.url || targetUrl.href;
    let contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

    // Detect M3U8
    const isM3u8 =
      finalUrl.includes('.m3u8') ||
      (contentType && /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i.test(contentType));

    if (!contentType) {
      contentType = isM3u8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    }

    const headers = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      // CRITICAL FIX: Expose headers so the player can read file sizes/ranges
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, ETag', 
      'Vary': 'Origin, Range',
    });

    if (isM3u8) {
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    } else {
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=31536000'); // Cache segments aggressively
    }

    // Forward upstream headers
    for (const key of ['Content-Range', 'Last-Modified', 'ETag']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    // Forward Content-Length for segments ONLY (never for rewritten manifests)
    if (!isM3u8) {
      const contentLength = upstream.headers.get('Content-Length');
      if (contentLength) headers.set('Content-Length', contentLength);
    }

    const stream = processResponseBody(upstream, contentType, finalUrl);

    return new Response(stream, {
      status: upstream.status,
      headers,
    });

  } catch (err) {
    if (timeout) clearTimeout(timeout);
    // Silent aborts are common in streaming, just return 504
    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Upstream timeout', 504);
    }
    console.error('HLS Proxy Error:', err);
    return c.text('Proxy Error', 502);
  }
});
