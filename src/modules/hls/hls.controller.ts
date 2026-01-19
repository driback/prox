import { createFactory } from 'hono/factory';
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
    timeout = setTimeout(() => controller.abort(), 120_000);
  } else {
    timeout = setTimeout(() => controller.abort(), 10_000);
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
      targetUrl.pathname.includes('.m3u8') ||
      (contentType && (
        /mpegurl/i.test(contentType) ||
        /vnd\.apple\.mpegurl/i.test(contentType) ||
        contentType === 'application/x-mpegurl' ||
        contentType === 'audio/x-mpegurl'
      ));

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
      const isLive = targetUrl.pathname.includes('live') || targetUrl.pathname.includes('master');
      if (isLive) {
        headers.set('Cache-Control', 'no-cache, max-age=0');
      } else {
        headers.set('Cache-Control', 'public, max-age=2');
      }
      headers.set('Pragma', 'no-cache');
    } else {
      headers.set('Accept-Ranges', 'bytes');
      const contentLength = upstream.headers.get('Content-Length');
      const contentRange = upstream.headers.get('Content-Range');
      if (contentLength && !contentRange) {
        headers.set('Content-Length', contentLength);
      }
    }

    if (upstream.status === 206) {
      const contentRange = upstream.headers.get('Content-Range');
      if (contentRange) {
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        if (match) {
          headers.set('Content-Length', String(parseInt(match[1]) - parseInt(contentRange.split(' ')[1].split('-')[0]) + 1));
        }
      }
    }

    for (const key of ['Content-Range', 'Last-Modified', 'ETag']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }

    const stream = processResponseBody(upstream, contentType, finalUrl);

    return new Response(stream, {
      status: upstream.status as 200 | 206,
      headers,
    });

  } catch (err) {
    if (timeout) clearTimeout(timeout);
    console.error('Media HLS Proxy Error:', err);
    
    if (process.env.DEBUG_HLS === 'true') {
      console.error('HLS Proxy Error Details:', {
        url: targetUrl.href,
        isPlaylist: isPlaylistRequest,
        error: (err as Error).message,
        stack: (err as Error).stack
      });
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      return c.text('Upstream timeout', 504);
    }

    return c.text('Proxy Error', 502);
  }
});
