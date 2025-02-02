import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { createFactory } from 'hono/factory';
import { processResponseBody } from './hls.helper';

const factory = createFactory();

export const HlsController = factory.createHandlers(async (c) => {
  const targetUrlString = c.req.query('url');
  if (!targetUrlString) {
    return c.text('No URL provided', 400);
  }

  try {
    const responseHeaders = new Headers({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      Expires: '0',
    });

    const response = await fetch(targetUrlString);
    if (!response.ok) {
      return c.text(
        `Fetch failed: ${response.status} ${response.statusText}`,
        response.status as ContentfulStatusCode
      );
    }

    const contentType =
      response.headers.get('content-type') || 'application/octet-stream';
    const bodyStream = processResponseBody(
      response,
      contentType,
      targetUrlString
    );

    return new Response(bodyStream, {
      status: 200,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Media Hls Proxy Error:', error);

    const errorMessage = error instanceof Error ? error.message : 'Proxy Error';
    return c.text(errorMessage, 500);
  }
});
