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

  try {
    const response = await fetch(targetUrl.href);
    if (!response.ok) {
      return c.text(
        `Fetch failed: ${response.status} ${response.statusText}`,
        response.status as ContentfulStatusCode
      );
    }

    const contentType =
      response.headers.get('content-type') ?? 'application/octet-stream';
    const headers = new Headers({
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
    });

    const bodyStream = processResponseBody(
      response,
      contentType,
      targetUrl.href
    );
    return new Response(bodyStream, { status: 200, headers });
  } catch (error) {
    console.error('Media HLS Proxy Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Proxy Error';
    return c.text(errorMessage, 500);
  }
});
