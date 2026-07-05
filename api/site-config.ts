import type { IncomingMessage, ServerResponse } from "node:http";

type SiteConfig = {
  supabase: {
    url: string;
    anonKey: string;
    enabled: boolean;
  };
  github: {
    repo: string;
    releasesUrl: string;
  };
  sharedProfileApi: string;
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  const githubRepo = process.env.GITHUB_REPO || "wobuzhi6322/BBBB";
  const config: SiteConfig = {
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      enabled: Boolean(supabaseUrl && supabaseAnonKey)
    },
    github: {
      repo: githubRepo,
      releasesUrl: `https://github.com/${githubRepo}/releases`
    },
    sharedProfileApi: "/api/shared-profile"
  };

  sendJson(res, 200, { ok: true, data: config });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(status === 204 ? undefined : JSON.stringify(body));
}
