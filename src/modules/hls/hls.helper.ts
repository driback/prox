// Compiled regex patterns for better performance
const MPEGURL_REGEX = /mpegurl/i;
const SEGMENT_REGEX =
  /^(?!#)(.+\.(?:m3u8|ts|cmf[va])|seg-.+\.cmf[va])(\?[^#\r\n]*)?$/gim;
const AUDIO_URI_REGEX = /URI="([^"]+)"/;
const MAP_URI_REGEX = /#EXT-X-MAP:URI="([^"]+)"/;

// Reusable text decoder/encoder instances
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

  return segment.includes('?') ? baseUrl.trim() : `${baseUrl}${search}`.trim();
};

const buildAudioUrl = (
  audioUrl: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  const pathSegments = pathname.split('/');
  const newPathname = pathSegments.slice(1, -1).join('/');
  const baseUrl = `${origin}/${newPathname}/${audioUrl}`;

  return audioUrl.includes('?') ? baseUrl.trim() : `${baseUrl}${search}`.trim();
};

const processLine = (
  line: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  // Handle audio lines
  if (line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
    const match = line.match(AUDIO_URI_REGEX);
    if (match?.[1]) {
      const audioUrl = match[1].replace('../', '');
      const segmentUrl = buildAudioUrl(audioUrl, origin, pathname, search);
      return line.replace(
        AUDIO_URI_REGEX,
        `URI="/hls?url=${encodeURIComponent(segmentUrl)}"`
      );
    }
    return line;
  }

  // Handle map lines
  if (line.startsWith('#EXT-X-MAP:')) {
    const match = line.match(MAP_URI_REGEX);
    if (match?.[1]) {
      const mapUrl = match[1].replace('../', '');
      const segmentUrl = buildSegmentUrl(mapUrl, origin, pathname, search);
      return line.replace(
        MAP_URI_REGEX,
        `#EXT-X-MAP:URI="/hls?url=${encodeURIComponent(segmentUrl)}"`
      );
    }
    return line;
  }

  // Handle segment lines
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

          for (const line of lines) {
            const processedLine = processLine(line, origin, pathname, search);
            controller.enqueue(TEXT_ENCODER.encode(`${processedLine}\n`));
          }
        }

        if (buffer) {
          const processedBuffer = processLine(buffer, origin, pathname, search);
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
