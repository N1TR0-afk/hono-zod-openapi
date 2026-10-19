import { Hono } from 'hono';
import type { MiddlewareHandler, TypedResponse } from 'hono';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as z from 'zod';
import { createOpenApiDocument } from './createOpenApiDocument.ts';
import { createOpenApiFragment, openApi } from './openApi.ts';

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

describe('createOpenApiFragment', () => {
  type FragmentEnv = {
    Bindings: { SESSIONS: Map<string, string> };
    Variables: { userId: string };
  };

  const openApiFragment = createOpenApiFragment<FragmentEnv>();
  const fragmentSessions = new Map([['valid-token', 'user-1']]);

  const fragmentAuth = openApiFragment(
    {
      responses: {
        401: { schema: z.object({ message: z.string() }) },
      },
      request: {
        header: z.object({ Authorization: z.string() }),
      },
    },
    async (c, next) => {
      const userId = await c.env.SESSIONS.get(
        c.req.valid('header').Authorization,
      );
      if (!userId) {
        return c.var.res(401, { message: 'Unauthorized' });
      }
      c.set('userId', userId);
      await next();
    },
  );

  it('inline middleware reads validated input, bindings and returns schema-checked responses', async () => {
    const app = new Hono<FragmentEnv>().post(
      '/user',
      fragmentAuth,
      openApiFragment({
        responses: {
          200: z.object({ userId: z.string() }),
        },
        request: {
          json: z.object({ name: z.string() }),
        },
      }),
      async (c) => c.var.res(200, { userId: c.var.userId }),
    );

    const ok = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'valid-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: fragmentSessions } satisfies FragmentEnv['Bindings'],
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: 'user-1' });

    const denied = await app.request(
      '/user',
      {
        method: 'POST',
        headers: {
          Authorization: 'missing-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: fragmentSessions } satisfies FragmentEnv['Bindings'],
    );
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ message: 'Unauthorized' });
  });

  it('fragment middleware still validates its own request part', async () => {
    const app = new Hono<FragmentEnv>().post(
      '/user',
      fragmentAuth,
      openApiFragment({
        responses: {
          200: z.object({ userId: z.string() }),
        },
        request: {
          json: z.object({ name: z.string() }),
        },
      }),
      async (c) => c.var.res(200, { userId: c.var.userId }),
    );

    const response = await app.request(
      '/user',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'John' }),
      },
      { SESSIONS: fragmentSessions } satisfies FragmentEnv['Bindings'],
    );

    expect(response.status).toBe(400);
  });

  it('openApi document is generated for fragment routes', () => {
    const app = new Hono<FragmentEnv>().post(
      '/user',
      openApiFragment(
        {
          responses: {
            200: z.object({ userId: z.string() }),
            401: {
              schema: z.object({ code: z.string(), message: z.string() }),
            },
          },
          request: {
            json: z.object({ name: z.string() }),
          },
        },
        async (c, next) => {
          if (
            !(await c.env.SESSIONS.get(c.req.header('Authorization') ?? ''))
          ) {
            return c.var.res(401, { code: 'UNAUTHORIZED', message: 'nope' });
          }
          await next();
        },
      ),
      async (c) => c.var.res(200, { userId: c.var.userId }),
    );

    const document = createOpenApiDocument(app, {
      info: { title: 'Test', version: '1.0.0' },
    });

    const post = document.paths?.['/user']?.post;
    expect(Object.keys(post?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '401']),
    );
    expect(post?.requestBody && 'content' in post.requestBody).toBe(true);
  });
});

describe('openApi fragment merging', () => {
  it('rejects nested request property and response schema conflicts at runtime', () => {
    const fragment = openApi({
      request: { header: z.object({ authorization: z.string() }) },
      responses: { 401: z.object({ message: z.string() }) },
    });

    expect(() =>
      openApi(
        {
          request: { header: z.object({ authorization: z.number() }) },
          responses: { 200: z.object({ ok: z.boolean() }) },
        },
        // @ts-expect-error the same header property has a different schema
        fragment,
      ),
    ).toThrow(/header\.authorization/);

    expect(() =>
      openApi(
        { responses: { 401: z.object({ message: z.number() }) } },
        // @ts-expect-error response status has a different schema
        fragment,
      ),
    ).toThrow(/response status '401'/);

    expect(() =>
      openApi(
        { responses: { 401: z.object({ message: z.string() }) } },
        fragment,
      ),
    ).not.toThrow();
  });

  it('merges disjoint properties within request targets for validation and docs', async () => {
    let authRuns = 0;
    const authFragment = openApi(
      {
        request: {
          header: z.object({ authorization: z.string().startsWith('Bearer ') }),
        },
        responses: { 401: z.object({ message: z.string() }) },
      },
      async (_c, next) => {
        authRuns += 1;
        await next();
      },
    );

    const app = new Hono().post(
      '/tasks',
      openApi(
        {
          request: {
            header: z.object({ 'x-request-id': z.string().min(1) }),
            json: z.object({ title: z.string() }),
          },
          responses: { 201: z.object({ title: z.string() }) },
        },
        authFragment,
      ),
      (c) => {
        const headers = c.req.valid('header');
        return c.var.res(201, {
          title: `${headers['x-request-id']}:${headers.authorization}`,
        });
      },
    );

    const response = await app.request('/tasks', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'x-request-id': 'req-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'task' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ title: 'req-1:Bearer token' });
    expect(authRuns).toBe(1);

    const document = createOpenApiDocument(
      app,
      { info: { title: 'Test', version: '1.0.0' } },
      { addRoute: false },
    );
    const headers = document.paths?.['/tasks']?.post?.parameters;
    expect(
      headers?.map((parameter) =>
        'name' in parameter ? parameter.name : undefined,
      ),
    ).toEqual(expect.arrayContaining(['authorization', 'x-request-id']));
  });

  it('merges multiple fragments once and preserves middleware order', async () => {
    const order: string[] = [];
    const authFragment = openApi(
      {
        request: {
          header: z.object({ authorization: z.string() }),
        },
        responses: {
          400: z.object({ message: z.string() }),
          401: z.object({ message: z.string() }),
        },
      },
      async (_c, next) => {
        order.push('auth-before');
        await next();
        order.push('auth-after');
      },
    );
    const requestIdFragment = openApi(
      {
        request: {
          header: z.object({ 'x-request-id': z.string().min(1) }),
        },
        responses: { 400: z.object({ message: z.string() }) },
      },
      async (_c, next) => {
        order.push('request-id-before');
        await next();
        order.push('request-id-after');
      },
    );
    const app = new Hono().post(
      '/tasks',
      openApi(
        {
          request: {
            json: z.object({ title: z.string() }),
          },
          responses: { 201: z.object({ title: z.string() }) },
        },
        authFragment,
        requestIdFragment,
      ),
      (c) => {
        order.push('handler');
        return c.var.res(201, { title: c.req.valid('json').title });
      },
    );

    const response = await app.request('/tasks', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'x-request-id': 'req-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'task' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ title: 'task' });
    expect(order).toEqual([
      'auth-before',
      'request-id-before',
      'handler',
      'request-id-after',
      'auth-after',
    ]);

    order.length = 0;
    const invalidResponse = await app.request('/tasks', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'task' }),
    });
    expect(invalidResponse.status).toBe(400);
    expect(order).toEqual([]);

    const document = createOpenApiDocument(
      app,
      { info: { title: 'Test', version: '1.0.0' } },
      { addRoute: false },
    );
    const operation = document.paths?.['/tasks']?.post;
    expect(
      operation?.parameters?.map((parameter) =>
        'name' in parameter ? parameter.name : undefined,
      ),
    ).toEqual(expect.arrayContaining(['authorization', 'x-request-id']));
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '401', '400']),
    );
  });

  it('keeps validate:false request properties documented but out of runtime validation', async () => {
    const authFragment = openApi({
      request: {
        header: z.object({ authorization: z.string() }),
      },
      responses: { 401: z.object({ message: z.string() }) },
    });
    const app = new Hono().get(
      '/me',
      openApi(
        {
          request: {
            header: {
              schema: z.object({ 'x-document-only': z.string() }),
              validate: false,
            },
          },
          responses: { 200: z.object({ ok: z.boolean() }) },
        },
        authFragment,
      ),
      (c) => c.var.res(200, { ok: true }),
    );

    const response = await app.request('/me', {
      headers: { authorization: 'Bearer token' },
    });
    expect(response.status).toBe(200);
  });

  it('composed fragment: the route\u0027s op status stays callable from the handler (c.var.res is not overwritten by the fragment\u0027s inner res)', async () => {
    const authFragment = openApi({
      responses: {
        401: z.object({ code: z.string(), message: z.string() }),
      },
    });

    const app = new Hono().get(
      '/user',
      openApi(
        {
          responses: {
            200: z.object({ userId: z.string() }),
          },
        },
        authFragment,
      ),
      (c) => c.var.res(200, { userId: 'u1' }),
    );

    const response = await app.request('/user');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: 'u1' });
  });

  it('nested fragment: operations merge into a single metadata (doc) payload', () => {
    const jwtOpenApi = openApi({
      security: [{ bearerAuth: [] }],
      tags: ['Auth'],
      request: {
        header: z.object({ authorization: z.string() }),
      },
      responses: {
        401: { schema: z.object({ message: z.string() }) },
      },
    });

    const app = new Hono().get(
      '/user',
      openApi(
        {
          tags: ['User'],
          responses: {
            200: z.object({ name: z.string() }),
          },
        },
        jwtOpenApi,
      ),
      (c) => {
        // nested fragment header validation is active at type level
        expectTypeOf(c.req.valid('header')).toEqualTypeOf<{
          authorization: string;
        }>();
        return c.json({ name: 'John' }, 200);
      },
    );

    const document = createOpenApiDocument(app, {
      info: { title: 'Test', version: '1.0.0' },
    });

    const post = document.paths?.['/user']?.get;
    expect(post?.security).toEqual([{ bearerAuth: [] }]);
    // nested fragments append their tags after the outer fragment's
    expect(post?.tags).toEqual(['User', 'Auth']);
    expect(Object.keys(post?.responses ?? {})).toEqual(['200', '401']);
  });

  it('stacked fragments: the doc merges the same way (later wins conflicts)', () => {
    const first = openApi({
      tags: ['Auth'],
      responses: {
        401: { schema: z.object({ message: z.string() }) },
      },
    });

    const second = openApi({
      tags: ['User'],
      responses: {
        200: z.object({ name: z.string() }),
      },
    });

    const app = new Hono().get('/user', first, second, (c) =>
      c.json({ name: 'John' }, 200),
    );

    const document = createOpenApiDocument(app, {
      info: { title: 'Test', version: '1.0.0' },
    });

    const post = document.paths?.['/user']?.get;
    expect(post?.tags).toEqual(['Auth', 'User']);
    expect(Object.keys(post?.responses ?? {})).toEqual(['200', '401']);
  });

  it('stacked fragments: matching response schemas can be redeclared', () => {
    const sameSchema = z.object({ name: z.string() });

    const first = openApi({
      responses: { 200: sameSchema },
      request: { json: sameSchema },
    });

    const second = openApi({
      responses: { 200: sameSchema },
      request: { json: sameSchema },
    });

    const app = new Hono().get('/user', first, second, (c) =>
      c.json(c.req.valid('json'), 200),
    );

    const document = createOpenApiDocument(app, {
      info: { title: 'Test', version: '1.0.0' },
    });
    expect(document.paths?.['/user']?.get?.responses?.['200']).toBeDefined();
  });

  it('stacked fragments: different response schemas conflict', () => {
    const first = openApi({
      responses: { 200: z.object({ name: z.string() }) },
    });
    const second = openApi({
      responses: { 200: z.object({ id: z.number() }) },
    });
    const app = new Hono().get('/user', first, second, (c) =>
      c.json({ name: 'John' }, 200),
    );

    expect(() =>
      createOpenApiDocument(app, {
        info: { title: 'Test', version: '1.0.0' },
      }),
    ).toThrow(/response status '200'/);
  });
});
