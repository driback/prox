// ==============================
// Regex patterns (compiled once)
// ==============================
const MPEGURL_REGEX = /mpegurl/i;

const SEGMENT_REGEX =
  /^(?!#)(.+\.(?:m3u8|ts|cmf[va]|m4s|m4v|m4a|mp4a|mp4v)|seg-.+\.(?:cmf[va]|m4s|m4v|m4a|mp4a|mp4v))(\?[^#\r\n]*)?$/gim;
const AUDIO_URI_REGEX = /URI="([^"]+)"/;
const MAP_URI_REGEX = /#EXT-X-MAP:URI="([^"]+)"/;

// ==============================
// Shared encoder / decoder
// ==============================
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

// ==============================
// Utilities
// ==============================
const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

const isAbsoluteUrl = (url: string): boolean =>
  /^https?:\/\//i.test(url) || url.startsWith("//");

// ==============================
// URL builders
// ==============================
const buildSegmentUrl = (
  segment: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  if (isAbsoluteUrl(segment)) {
    return segment;
  }

  const baseUrl = segment.startsWith("/")
    ? `${origin}${segment}`
    : `${origin}${pathname}/${segment}`;

  return segment.includes("?") ? baseUrl.trim() : `${baseUrl}${search}`.trim();
};

const buildAudioUrl = (
  audioUrl: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  if (isAbsoluteUrl(audioUrl)) {
    return audioUrl;
  }

  const pathSegments = pathname.split("/");
  const newPathname = pathSegments.slice(1, -1).join("/");
  const baseUrl = `${origin}/${newPathname}/${audioUrl}`;

  return audioUrl.includes("?") ? baseUrl.trim() : `${baseUrl}${search}`.trim();
};

// ==============================
// Line processor
// ==============================
const processLine = (
  line: string,
  origin: string,
  pathname: string,
  search: string
): string => {
  // --- AUDIO tracks (master playlist) ---
  if (line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
    const match = line.match(AUDIO_URI_REGEX);
    if (match?.[1]) {
      const audioUrl = match[1].replace("../", "");
      const resolved = buildAudioUrl(audioUrl, origin, pathname, search);
      return line.replace(
        AUDIO_URI_REGEX,
        `URI="/hls?url=${encodeURIComponent(resolved)}"`
      );
    }
    return line;
  }

  // --- EXT-X-MAP (init segments) ---
  if (line.startsWith("#EXT-X-MAP:")) {
    const match = line.match(MAP_URI_REGEX);
    if (match?.[1]) {
      const mapUrl = match[1].replace("../", "");
      const resolved = buildSegmentUrl(mapUrl, origin, pathname, search);
      return line.replace(
        MAP_URI_REGEX,
        `#EXT-X-MAP:URI="/hls?url=${encodeURIComponent(resolved)}"`
      );
    }
    return line;
  }

  // --- Media segments / variant playlists ---
  return line.replace(SEGMENT_REGEX, (segment) => {
    const resolved = buildSegmentUrl(segment, origin, pathname, search);
    return `/hls?url=${encodeURIComponent(resolved)}`;
  });
};

// ==============================
// Streaming playlist rewriter
// ==============================
const streamPlaylistRewrite = (
  stream: ReadableStream<Uint8Array>,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  const url = new URL(targetUrl);
  const { origin, pathname: fullPathname, search } = url;
  const pathname = fullPathname.substring(0, fullPathname.lastIndexOf("/"));

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += TEXT_DECODER.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const processed = processLine(line, origin, pathname, search);
            controller.enqueue(TEXT_ENCODER.encode(`${processed}\n`));
          }
        }

        if (buffer) {
          const processed = processLine(buffer, origin, pathname, search);
          controller.enqueue(TEXT_ENCODER.encode(processed));
        }
      } catch (err) {
        controller.error(err);
      } finally {
        controller.close();
      }
    },
  });
};

// ==============================
// Public entry
// ==============================
export const processResponseBody = (
  response: Response,
  contentType: string,
  targetUrl: string
): ReadableStream<Uint8Array> => {
  if (!MPEGURL_REGEX.test(contentType)) {
    return response.body ?? createEmptyStream();
  }

  if (!response.body) {
    console.warn("No response body for HLS playlist");
    return createEmptyStream();
  }

  return streamPlaylistRewrite(response.body, targetUrl);
};
