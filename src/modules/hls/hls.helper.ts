const URI_ATTR_REGEX = /URI="([^"]+)"/;

const TEXT_ENCODER = new TextEncoder();

const createEmptyStream = (): ReadableStream<Uint8Array> => {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
};

const resolveAndProxyUrl = (targetPath: string, manifestBaseUrl: string): string => {
  try {
    const resolvedUrl = new URL(targetPath, manifestBaseUrl).toString();
    return `/hls?url=${encodeURIComponent(resolvedUrl)}`;
  } catch (e) {
    return targetPath;
  }
};

const processLine = (
  line: string,
  manifestBaseUrl: string
): string => {
  const trimmedLine = line.trim();

  if (!trimmedLine) return line;

  if (trimmedLine.startsWith('#')) {
    if (
      trimmedLine.startsWith('#EXT-X-MEDIA') || 
      trimmedLine.startsWith('#EXT-X-MAP') || 
      trimmedLine.startsWith('#EXT-X-KEY')
    ) {
      return line.replace(URI_ATTR_REGEX, (match, uriValue) => {
        const proxiedUrl = resolveAndProxyUrl(uriValue, manifestBaseUrl);
        return `URI="${proxiedUrl}"`;
      });
    }
    return line;
  }

  return resolveAndProxyUrl(trimmedLine, manifestBaseUrl);
};

const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = '';
      
      const decoder = new TextDecoder('utf-8', { fatal: false });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const processed = processLine(line, targetUrl);
            controller.enqueue(TEXT_ENCODER.encode(`${processed}\n`));
          }
        }

        buffer += decoder.decode();

        if (buffer) {
          const processed = processLine(buffer, targetUrl);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  const isPlaylist = 
    /application\/vnd\.apple\.mpegurl|audio\/mpegurl/i.test(contentType) ||
    targetUrl.includes('.m3u8');

  if (!isPlaylist || !response.body) {
    return response.body || createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
