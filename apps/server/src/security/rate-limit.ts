import { Context, Next } from "hono";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function policy(method: string, path: string) {
  if (path.includes("/auth/sign-up") || path.includes("/auth/sign-in") || path.includes("/forget-password")) {
    return { limit: 10, windowMs: 60_000 };
  }
  if (method === "GET" && path.endsWith("/users/search")) return { limit: 60, windowMs: 60_000 };
  if (method === "POST" && /\/requests\/?$/.test(path)) return { limit: 30, windowMs: 86_400_000 };
  if (method === "POST" && /\/chats\/[^/]+\/messages$/.test(path)) return { limit: 90, windowMs: 60_000 };
  if (method === "POST" && path.endsWith("/report")) return { limit: 10, windowMs: 86_400_000 };
  return null;
}

export async function rateLimitMiddleware(c: Context, next: Next) {
  const selected = policy(c.req.method, c.req.path);
  if (!selected || process.env.NODE_ENV === "test") return next();

  const identity =
    c.req.header("authorization") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown";
  const key = `${identity}:${c.req.method}:${c.req.path.replace(/[0-9a-f-]{20,}/gi, ":id")}`;
  const now = Date.now();
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + selected.windowMs }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count > selected.limit) {
    c.header("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return c.json({ code: "RATE_LIMITED", message: "Too many requests" }, 429);
  }
  return next();
}
