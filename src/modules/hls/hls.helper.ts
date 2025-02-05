const regex = /mpegurl/i;

const createEmptyStream = (): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
};

const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
) => {
  const originalUrl = new URL(targetUrl);
  const origin = originalUrl.origin;
  const pathname = originalUrl.pathname.substring(
    0,
    originalUrl.pathname.lastIndexOf('/')
  );
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const segmentRegexM = /^(?!#)(.*\.m3u8)(\?[^#\r\n]+)?/gi;
  const segmentRegexTs = /^(?!#)(.*\.ts)(\?[^#\r\n]+)?/gi;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let partialChunk = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        partialChunk += decoder.decode(value, { stream: true });
        const lines = partialChunk.split('\n');
        partialChunk = lines.pop() ?? '';

        for (const line of lines) {
          const modifiedLine = line
            .replace(segmentRegexM, (segment) => {
              let segmentUrl = segment;

              if (segment.startsWith('/')) {
                segmentUrl = `${origin}/${segment}${originalUrl.search}`.trim();
              } else {
                segmentUrl =
                  `${origin}${pathname}/${segment}${originalUrl.search}`.trim();
              }

              return `/hls?url=${encodeURIComponent(segmentUrl)}`;
            })
            .replace(segmentRegexTs, (segment) => {
              let segmentUrl = segment;

              if (segment.startsWith('/')) {
                segmentUrl = `${origin}/${segment}${originalUrl.search}`.trim();
              } else {
                segmentUrl =
                  `${origin}${pathname}/${segment}${originalUrl.search}`.trim();
              }
              return `/hls?url=${encodeURIComponent(segmentUrl)}`;
            });
          controller.enqueue(encoder.encode(`${modifiedLine}\n`));
        }
      }
      if (partialChunk) {
        controller.enqueue(encoder.encode(partialChunk));
      }
      controller.close();
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  if (regex.test(contentType)) {
    if (!response.body) {
      console.warn('No response body for HLS playlist');
      return createEmptyStream();
    }
    return streamPlaylistRewrite(response.body, targetUrl);
  }
  return response.body || createEmptyStream();
};
