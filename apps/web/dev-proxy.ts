/**
 * What the console answers when its own `/api` proxy cannot reach the API.
 *
 * `http-proxy`'s default is a bare `500` with an **empty body**, and that is the one failure the
 * console cannot explain. `requestJson` reads the status, finds no body, and reports
 * `GET /api/ownership failed with HTTP 500: <empty body>` — so a founder whose API is stopped or
 * restarting sees "the company list is unavailable" with no way to tell a dead backend from a
 * broken response, and (before the gate fix) no Sign in button to press either.
 *
 * The proxy is the only layer that knows the address it forwards to, so it says it: a `502`
 * naming the target it could not reach, in the same `{ error, message }` shape every API failure
 * uses. This is a true statement — the console *did* fail to reach a gateway — and the detail
 * `requestJson` renders is the address plus the OS-level reason, not an empty string.
 *
 * Both functions are pure so the response can be asserted without a live server.
 */

/** The status for "the upstream did not answer": bad gateway, not an internal console error. */
export const PROXY_FAILURE_STATUS = 502;

export interface ProxyFailure {
  readonly status: number;
  readonly contentType: string;
  /** A JSON document in the `{ error, message }` shape the console's transport already parses. */
  readonly body: string;
}

/** The `host:port` the console's dev/preview proxy forwards `/api` to. */
export function proxyTarget(port: string | undefined = process.env['PORT']): string {
  return `http://localhost:${port === undefined || port.trim() === '' ? '3001' : port.trim()}`;
}

/**
 * The response for a failed proxy hop.
 *
 * The message is deliberately actionable rather than a stack trace: the overwhelmingly common
 * cause is that the API process is not running, and the fix is one command.
 */
export function proxyFailure(target: string, cause: unknown): ProxyFailure {
  const reason = cause instanceof Error ? cause.message : String(cause);
  return {
    status: PROXY_FAILURE_STATUS,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({
      error: 'api_unreachable',
      message: `the API at ${target} did not answer (${reason}) — start it with \`pnpm dev\``,
      target,
    }),
  };
}

/**
 * The response surface a failed hop is answered through.
 *
 * `http-proxy` calls the error handler with either a real `ServerResponse` or the bare socket,
 * depending on how far the hop got, and its own types only describe the first. This is the
 * structural slice the handler actually uses, so the branch is decided by what is present at
 * runtime instead of by a cast the compiler cannot check.
 */
interface ReplyTarget {
  readonly headersSent?: boolean;
  writeHead?: (status: number, headers: Record<string, string>) => unknown;
  end?: (body: string) => unknown;
  destroy?: () => void;
}

function replyTarget(response: unknown): ReplyTarget {
  return typeof response === 'object' && response !== null ? (response as ReplyTarget) : {};
}

/**
 * Answer a failed proxy hop with the explanatory body.
 *
 * Returns whether a response was written. When the hop never got as far as a response the only
 * honest move is to cut the connection — but never to leave a bare `500` with no body, which is the
 * failure this whole module exists to remove. The methods are called through `.call(reply, …)` so
 * they keep the response as their receiver.
 */
export function answerProxyFailure(response: unknown, failure: ProxyFailure): boolean {
  const reply = replyTarget(response);
  const { writeHead, end } = reply;
  if (writeHead !== undefined && end !== undefined && reply.headersSent !== true) {
    writeHead.call(reply, failure.status, { 'content-type': failure.contentType });
    end.call(reply, failure.body);
    return true;
  }
  reply.destroy?.();
  return false;
}
