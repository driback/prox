type UrlParts = {
  baseUrl: string;
  search: string;
};

const MPEGURL_REGEX = /mpegurl|m3u8/i;
const GENERIC_URI_REGEX = /URI\s*=\s*"([^"]+)"/g; 
const REWRITE_PREFIX = "/hls?url=";

export const createEmptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) { controller.close(); },
  });

export const isAbsoluteUrl = (url: string): boolean => 
  url.startsWith('https://') || url.startsWith('http://');

export const createProxyUrl = (target: string): string =>
  `${REWRITE_PREFIX}${encodeURIComponent(target)}`;

export const extractUrlParts = (finalUrl: string): UrlParts => {
  try {
    const url = new URL(finalUrl);
    const pathname = url.pathname.substring(0, url.pathname.lastIndexOf("/") + 1);
    return {
      baseUrl: `${url.origin}${pathname}`,
      search: url.search,
    };
  } catch {
    return { baseUrl: "", search: "" };
  }
};

export const buildCompleteUrl = (lineUri: string, parts: UrlParts): string => {
  let resolvedUrl: string;
  
  const isAbsolute = lineUri.startsWith('h') && (lineUri.startsWith('https://') || lineUri.startsWith('http://'));
  
  if (isAbsolute) {
    resolvedUrl = lineUri;
  } else {
    const firstChar = lineUri.charCodeAt(0);
    
    if (firstChar === 47 || firstChar === 46) {
        try {
            resolvedUrl = new URL(lineUri, parts.baseUrl).href;
        } catch {
            resolvedUrl = lineUri;
        }
    } else {
        resolvedUrl = parts.baseUrl + lineUri;
    }
  }

  if (parts.search) {
    const tokenClean = parts.search.substring(1); 
    if (!resolvedUrl.includes(tokenClean)) {
      const separator = resolvedUrl.includes('?') ? '&' : '?';
      resolvedUrl += separator + tokenClean;
    }
  }

  return resolvedUrl;
};

const processLine = (line: string, parts: UrlParts): string => {
  if (!line) return line;

  const cleanLine = line.trim();
  if (!cleanLine) return line;

  if (cleanLine.charCodeAt(0) === 35) {
    if (!cleanLine.includes('URI=')) {
        return cleanLine;
    }

    return cleanLine.replace(GENERIC_URI_REGEX, (_, uri) => {
      const fullUrl = buildCompleteUrl(uri, parts);
      return `URI="${createProxyUrl(fullUrl)}"`;
    });
  }

  return createProxyUrl(buildCompleteUrl(cleanLine, parts));
};

const createHlsTransformer = (parts: UrlParts) => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      
      let boundary = buffer.indexOf('\n');
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        
        const processed = processLine(line, parts);
        controller.enqueue(encoder.encode(processed + '\n'));
        
        boundary = buffer.indexOf('\n');
      }
    },
    flush(controller) {
      if (buffer) {
        const processed = processLine(buffer, parts);
        controller.enqueue(encoder.encode(processed));
      }
    },
  });
};

export const processResponseBody = (
  response: Response,
  contentType: string,
  finalUrl: string
): ReadableStream<Uint8Array> => {
  const stream = response.body;
  if (!stream) return createEmptyStream();

  if (!MPEGURL_REGEX.test(contentType)) {
    return stream;
  }

  const contentLength = response.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength) > 1024 * 1024 * 10) {
    return stream;
  }

  const urlParts = extractUrlParts(finalUrl);
  return stream.pipeThrough(createHlsTransformer(urlParts));
};