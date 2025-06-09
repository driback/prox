const MPEGURL_REGEX = /mpegurl/i;
const SEGMENT_REGEX =
  /^(?!#)(.+\.(?:m3u8|ts|cmf[va])|seg-.+\.cmf[va])(\?[^#\r\n]*)?$/gim;
const AUDIO_URI_REGEX = /URI="([^"]+)"/;
const MAP_URI_REGEX = /#EXT-X-MAP:URI="([^"]+)"/;

const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

const createEmptyStream = (): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
};

const buildSegmentUrl = (
  segment: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  const baseUrl = segment.startsWith('/')
    ? `${origin}${segment}`
    : `${origin}${pathname}/${segment}`;

  return `${baseUrl}${search}`.trim();
};

const processAudioLine = (
  line: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  const match = line.match(AUDIO_URI_REGEX);
  if (!match?.[1]) return line;

  const audioUrl = match[1].replace('../', '');
  const pathSegments = pathname.split('/');
  const newPathname = pathSegments.slice(1, -1).join('/');
  const segmentUrl = `${origin}/${newPathname}/${audioUrl}${search}`.trim();

  return line.replace(
    AUDIO_URI_REGEX,
    `URI="/hls?url=${encodeURIComponent(segmentUrl)}"`
  );
};

const processMapLine = (
  line: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  const match = line.match(MAP_URI_REGEX);
  if (!match?.[1]) return line;

  const mapUrl = match[1].replace('../', '');
  const segmentUrl = buildSegmentUrl(mapUrl, origin, pathname, search);

  return line.replace(
    MAP_URI_REGEX,
    `#EXT-X-MAP:URI="/hls?url=${encodeURIComponent(segmentUrl)}"`
  );
};

const processSegmentLine = (
  line: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  return line.replace(SEGMENT_REGEX, (segment) => {
    const segmentUrl = buildSegmentUrl(segment, origin, pathname, search);
    return `/hls?url=${encodeURIComponent(segmentUrl)}`;
  });
};

const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  const url = new URL(targetUrl);
  const { origin, pathname: fullPathname, search } = url;
  const pathname = fullPathname.substring(0, fullPathname.lastIndexOf('/'));

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += TEXT_DECODER.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (let line of lines) {
            // Process different line types
            if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
              line = processAudioLine(line, origin, pathname, search);
            } else if (line.startsWith('#EXT-X-MAP:')) {
              line = processMapLine(line, origin, pathname, search);
            } else {
              // Process segment lines (including .cmfv files)
              line = processSegmentLine(line, origin, pathname, search);
            }

            controller.enqueue(TEXT_ENCODER.encode(`${line}\n`));
          }
        }

        // Handle remaining buffer content
        if (buffer) {
          let processedBuffer = buffer;

          if (buffer.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
            processedBuffer = processAudioLine(
              buffer,
              origin,
              pathname,
              search
            );
          } else if (buffer.startsWith('#EXT-X-MAP:')) {
            processedBuffer = processMapLine(buffer, origin, pathname, search);
          } else {
            processedBuffer = processSegmentLine(
              buffer,
              origin,
              pathname,
              search
            );
          }

          controller.enqueue(TEXT_ENCODER.encode(processedBuffer));
        }
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  if (!MPEGURL_REGEX.test(contentType)) {
    return response.body || createEmptyStream();
  }

  if (!response.body) {
    console.warn('No response body for HLS playlist');
    return createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
