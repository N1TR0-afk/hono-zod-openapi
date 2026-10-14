import { Hono } from 'hono';
import type { MiddlewareHandler, TypedResponse } from 'hono';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createOpenApiDocument } from './createOpenApiDocument.ts';
import { openApi } from './openApi.ts';

interface AppBindings {
  SESSIONS: Map<string, string>;
}
type AppEnv = {
  Bindings: AppBindings;
  Variables: { userId: string };
};

type UnauthorizedResponse = Response &
  TypedResponse<{ message: string }, 401, 'json'>;

const sessions = new Map([['valid-token', 'user-1']]);

// Reusable middleware, annotated once with its environment and response types.
const auth: MiddlewareHandler<
  AppEnv,
  string,
  Record<never, never>,
  UnauthorizedResponse
> = createTypedAuth();

function createTypedAuth(): MiddlewareHandler<
  AppEnv,
  string,
  Record<never, never>,
  UnauthorizedResponse
> {
  return async (c, next) => {
    const token = c.req.header('Authorization');
    const userId = await c.env.SESSIONS.get(token ?? '');

    if (!userId) {
      return c.json({ message: 'Unauthorized' }, 401);
    }

    c.set('userId', userId);
    await next();
  };
}

const buildApp = () =>
  new Hono<AppEnv>().post(
    '/user',
    openApi(
      {
        responses: {
          200: z.object({ name: z.string() }),
          401: z.object({ message: z.string() }),
        },
        request: {
          json: z.object({ name: z.string() }),
        },
      },
      auth,
    ),
    async (c) => {
      const { name } = c.req.valid('json');
      return c.json({ name }, 200);
    },
  );

describe('openApi with reusable middleware', () => {
  it('runs middleware in order: validators, openApi, user middleware, handler', async () => {
    const order: string[] = [];
    const tracer: MiddlewareHandler = async (_c, next) => {
      order.push('mw');
      await next();
    };

    const app = new Hono<AppEnv>().post(
      '/user',
      openApi(
        {
          responses: {
            200: z.object({ name: z.string() }),
            401: z.object({ message: z.string() }),
          },
          request: {
            json: z.object({ name: z.string() }),
          },
        },
        auth,
        tracer,
      ),
      async (c) => {
        expect(order).toEqual(['mw']);
        const { name } = c.req.valid('json');
        return c.json({ name }, 200);
      },
    );

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(['mw']);
  });

  it('middleware early response stops the handler and is surfaced to the client', async () => {
    const app = buildApp();

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: 'Unauthorized' });
  });

  it('middleware with next() continues to the handler with the request still validated', async () => {
    const app = buildApp();

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'John' });
  });

  it('request validation remains active on routes using the helper', async () => {
    const app = buildApp();

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 123 }),
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { message: string };
      success: boolean;
    };
    expect(body.success).toBe(false);
    expect(body.error.message).toContain('expected string, received number');
  });

  it('middleware reads typed bindings passed via request env', async () => {
    const app = buildApp();
    const runtimeSessions = new Map([['env-token', 'user-1']]);

    const ok = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'env-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: runtimeSessions } satisfies AppBindings,
    );
    expect(ok.status).toBe(200);

    const failed = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'env-token-missing',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: runtimeSessions } satisfies AppBindings,
    );
    expect(failed.status).toBe(401);
  });

  it('middleware set variables are available in the handler', async () => {
    const app = new Hono<AppEnv>().post(
      '/user',
      openApi(
        {
          responses: {
            200: z.object({ userId: z.string() }),
            401: z.object({ message: z.string() }),
          },
        },
        auth,
      ),
      async (c) => {
        return c.json({ userId: c.var.userId }, 200);
      },
    );

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: { Authorization: 'valid-token' },
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'user-1' });
  });

  it('middleware is reusable across routes', async () => {
    const app = new Hono<AppEnv>()
      .post(
        '/user',
        openApi(
          {
            responses: {
              200: z.object({ name: z.string() }),
              401: z.object({ message: z.string() }),
            },
            request: {
              json: z.object({ name: z.string() }),
            },
          },
          auth,
        ),
        async (c) => c.json({ name: c.var.userId }, 200),
      )
      .get(
        '/secret',
        openApi(
          {
            responses: {
              200: z.object({ secret: z.string() }),
              401: z.object({ message: z.string() }),
            },
          },
          auth,
        ),
        async (c) => c.json({ secret: c.var.userId }, 200),
      );

    const unauthorized = await app.request(
      '/user',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: sessions } satisfies AppBindings,
    );
    expect(unauthorized.status).toBe(401);

    const secret = await app.request(
      '/secret',
      { headers: { Authorization: 'valid-token' } },
      { SESSIONS: sessions } satisfies AppBindings,
    );
    expect(secret.status).toBe(200);
    expect(await secret.json()).toEqual({ secret: 'user-1' });
  });

  it('res helper is still available to the handler', async () => {
    const app = new Hono<AppEnv>().get(
      '/user',
      openApi(
        {
          responses: {
            200: z.object({ name: z.string() }),
            401: z.object({ message: z.string() }),
          },
        },
        auth,
      ),
      async (c) => c.var.res({ name: 'John' }),
    );

    const response = await app.request(
      '/user',
      { headers: { Authorization: 'valid-token' } },
      { SESSIONS: sessions } satisfies AppBindings,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: 'John' });
  });

  it('openApi document reflects the schema of helper routes', () => {
    const app = buildApp();

    const document = createOpenApiDocument(app, {
      info: { title: 'Test', version: '1.0.0' },
    });

    const post = document.paths?.['/user']?.post;
    expect(post).toBeDefined();

    const responses = post?.responses;
    expect(Object.keys(responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401']),
    );

    expect(
      (responses as Record<string, { content?: Record<string, unknown> }>)?.[
        '200'
      ]?.content?.['application/json'],
    ).toBeDefined();

    expect(post?.requestBody && 'content' in post.requestBody).toBe(true);
  });
});
