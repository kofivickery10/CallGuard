import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'http';
import { lookupFeedback, confirmFeedback } from '../services/journey-feedback.js';

// This test guards a mount-order trap, not just a code path:
//
//   app.use('/api', feedbackRouter)   -- authenticated supervisor routes
//
// `feedbackRouter`'s own routes live under /journeys/:journeyId/feedback, so
// it has no route matching `/api/feedback/<token>` at all. But in Express 4,
// `router.use(fn)` (no path) runs for every request that reaches the router,
// matching route or not. If auth is ever put back as router-level middleware
// on `feedbackRouter` (`feedbackRouter.use(authenticate, requireActioner)`)
// instead of per-route, `GET /api/feedback/<token>` will hit that router
// first, get 401'd by `authenticate`, and never reach
// `publicFeedbackRouter` — which is exactly the bug this test exists to
// catch. Do not "simplify" the per-route auth back into a single
// `router.use(...)` call, and do not reorder the two `app.use` calls that
// mount these routers in app.ts.

vi.mock('../services/journey-feedback.js', async () => {
  const actual = await vi.importActual<typeof import('../services/journey-feedback.js')>(
    '../services/journey-feedback.js'
  );
  return {
    ...actual,
    // Real DB-bound logic is covered elsewhere (hashing) or needs a live DB
    // (send/confirm/adviser resolution) — irrelevant to this test, which is
    // only about which router a request reaches and, now, which one of the
    // two handlers a page load vs. a confirm click hits. 'not_found' is a
    // real, successful outcome of both lookupFeedback and confirmFeedback (an
    // unrecognised token), so it exercises the same response path a bad link
    // would without touching the database.
    lookupFeedback: vi.fn().mockResolvedValue({ status: 'not_found' }),
    confirmFeedback: vi.fn().mockResolvedValue({ status: 'not_found' }),
  };
});

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Imported after the mock above is registered, and only once, so app.ts's
  // module-level router wiring (including the mount order under test) is
  // exercised exactly as it runs in production.
  const { app } = await import('../app.js');
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('journey feedback routes mounted at the bare /api prefix', () => {
  it('reaches the public handler for a token, with no Authorization header', async () => {
    const token = 'a'.repeat(43);
    const res = await fetch(`${baseUrl}/api/feedback/${token}`);

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('not_found');
  });

  it('still 401s the supervisor route with no Authorization header', async () => {
    const journeyId = '00000000-0000-0000-0000-000000000000';
    const res = await fetch(`${baseUrl}/api/journeys/${journeyId}/feedback`);

    expect(res.status).toBe(401);
  });

  it('GET is a read-only status check: it never confirms', async () => {
    // The whole point of the fix: a page load (which is all a prefetching
    // mail-security gateway ever does) must not be able to record an
    // acknowledgment. Only the POST below can.
    vi.mocked(confirmFeedback).mockClear();
    vi.mocked(lookupFeedback).mockClear();
    const token = 'b'.repeat(43);

    const res = await fetch(`${baseUrl}/api/feedback/${token}`);

    expect(res.status).toBe(200);
    expect(lookupFeedback).toHaveBeenCalledWith(token);
    expect(confirmFeedback).not.toHaveBeenCalled();
  });

  it('POST /:token/confirm reaches the confirm handler, with no Authorization header', async () => {
    vi.mocked(confirmFeedback).mockClear();
    const token = 'c'.repeat(43);

    const res = await fetch(`${baseUrl}/api/feedback/${token}/confirm`, { method: 'POST' });

    expect(res.status).not.toBe(401);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('not_found');
    expect(confirmFeedback).toHaveBeenCalled();
  });
});
