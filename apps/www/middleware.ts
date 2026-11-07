import { next } from "@vercel/functions";
import {
  AGENT_DISCOVERY_LINKS,
  getMarkdownAlternate,
  getMarkdownDocument,
  markdownResponse,
  negotiateRepresentation,
} from "./src/agent-content.js";

const VARY_HEADER = "Accept, Accept-Encoding";
const APEX_ORIGIN = "https://rakazo.com";
const WWW_HOST = "www.rakazo.com";

export const config = {
  matcher: ["/((?!api|_astro|.*\\..*).*)", "/sitemap.xml"],
};

function permanentRedirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { Location: location },
  });
}

// A path of `//host` or `/\host` is protocol-relative, so `new URL(path, APEX_ORIGIN)` would
// resolve it to a different origin. Assigning the path keeps the apex origin and only normalizes
// the slash run.
function apexUrl(pathname: string, search: string): URL {
  const destination = new URL(APEX_ORIGIN);
  destination.pathname = pathname.replace(/^[\\/]+/, "/");
  destination.search = search;
  return destination;
}

export default function middleware(request: Request): Response {
  const url = new URL(request.url);

  if (url.hostname.toLowerCase() === WWW_HOST) {
    return permanentRedirect(apexUrl(url.pathname, url.search).toString());
  }

  if (url.pathname === "/sitemap.xml") {
    return permanentRedirect(apexUrl("/sitemap-index.xml", url.search).toString());
  }

  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const acceptHeader = request.headers.get("accept");
  const representation = negotiateRepresentation(acceptHeader);
  const markdown = getMarkdownDocument(url.pathname);

  if (representation === "markdown" && markdown) {
    return markdownResponse(markdown, request.method);
  }

  if (representation === "not-acceptable") {
    return new Response(
      request.method === "HEAD"
        ? null
        : "Not acceptable. Request text/html or text/markdown.\n",
      {
        status: 406,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          Vary: VARY_HEADER,
        },
      },
    );
  }

  const markdownAlternate = getMarkdownAlternate(url.pathname);
  return next({
    headers: {
      Link: [
        AGENT_DISCOVERY_LINKS,
        ...(markdownAlternate
          ? [`<${markdownAlternate}>; rel="alternate"; type="text/markdown"`]
          : []),
      ].join(", "),
      Vary: VARY_HEADER,
    },
  });
}
