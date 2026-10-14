import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler, TypedResponse } from 'hono';
import { hc } from 'hono/client';
import type { InferRequestType } from 'hono/client';
import { describe, expectTypeOf, it } from 'vitest';
import * as z from 'zod';
import { createOpenApiFragment, openApi } from './openApi.ts';

interface AppBindings {
  SESSIONS: Map<string, string>;
  KV: { get(key: string): Promise<string | null> };
}
type AppEnv = {
  Bindings: AppBindings;
  Variables: { userId: string };
};

type UnauthorizedResponse = Response &
  TypedResponse<{ message: string }, 401, 'json'>;

/**
 * Reusable middleware, annotated exactly once. Bindings, variables and
 * early-response types must flow through `openApi()` without any cast at the
 * call site.
 */
const auth: MiddlewareHandler<
  AppEnv,
  string,
  Record<never, never>,
  UnauthorizedResponse
> = async (c, next) => {
  expectTypeOf(c.env.SESSIONS).toEqualTypeOf<AppBindings['SESSIONS']>();
  expectTypeOf(c.env.KV).toEqualTypeOf<AppBindings['KV']>();

  // @ts-expect-error the middleware env is precise, not `any`: unknown bindings are rejected
  const _unknownBinding = c.env.NOT_A_REAL_BINDING;

  const session = await c.env.SESSIONS.get(c.req.header('Authorization') ?? '');
  if (!session) {
    return c.json({ message: 'Unauthorized' }, 401);
  }

  c.set('userId', session);
  await next();
};

const routes = new Hono<AppEnv>()
  .post(
    '/user',
    // accepted without any caller-side cast; env and response types are inferred
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
      // app bindings, middleware variables and the res helper survive into the handler
      expectTypeOf(c.env.KV).toEqualTypeOf<AppBindings['KV']>();
      expectTypeOf(c.env.SESSIONS).toEqualTypeOf<AppBindings['SESSIONS']>();
      expectTypeOf(c.var.userId).toEqualTypeOf<string>();
      expectTypeOf(c.var.res(200, { name: 'John' })).toEqualTypeOf<
        Response & TypedResponse<{ name: string }, 200, 'json'>
      >();

      const { name } = c.req.valid('json');
      expectTypeOf(name).toEqualTypeOf<string>();

      // @ts-expect-error only declared request targets are accepted
      const _invalid = c.req.valid('query');

      return c.json({ name }, 200);
    },
  )
  /**
   * A middleware without declared response types is accepted (env is still
   * inferred); it just does not contribute middleware responses to the client
   * schema, matching Hono's own response-merge rule (only `TypedResponse`
   * members are merged).
   */
  .get(
    '/logger',
    openApi(
      {
        responses: {
          200: z.object({ hi: z.string() }),
        },
      },
      (async (_c, next) => {
        await next();
      }) satisfies MiddlewareHandler<AppEnv, string, Record<never, never>>,
    ),
    async (c) => {
      expectTypeOf(c.env.SESSIONS).toEqualTypeOf<AppBindings['SESSIONS']>();
      return c.json({ hi: 'you' }, 200);
    },
  );

export type AppType = typeof routes;

const client = hc<AppType>('http://localhost/');

it('client infers request types derived from validation', () => {
  expectTypeOf<InferRequestType<typeof client.user.$post>>().not.toBeNever();
  expectTypeOf<
    InferRequestType<typeof client.user.$post>['json']
  >().toEqualTypeOf<{
    name: string;
  }>();
});

it('client infers success and middleware-provided 401 responses', async () => {
  const res = await client.user.$post({ json: { name: 'John' } });

  if (res.status === 200) {
    expectTypeOf(await res.json()).toEqualTypeOf<{ name: string }>();
  }
  if (res.status === 401) {
    expectTypeOf(await res.json()).toEqualTypeOf<{ message: string }>();
  }

  // @ts-expect-error request shape is derived from validation
  await client.user.$post({ json: { name: 123 } });
});

it('routes without the helper keep their client inference', async () => {
  const res = await client.logger.$get();
  if (res.status === 200) {
    expectTypeOf(await res.json()).toEqualTypeOf<{ hi: string }>();
  }
});

it('stacked openApi calls: inputs intersect and res payloads stay schema-checked', async () => {
  await new Hono<AppEnv>().post(
    '/stack',
    openApi(
      {
        responses: {
          200: z.object({ first: z.string() }),
          401: z.object({ message: z.string() }),
        },
        request: {
          json: z.object({ name: z.string() }),
        },
      },
      auth,
    ),
    openApi({
      responses: {
        400: z.object({ second: z.string() }),
      },
      request: {
        json: z.object({ email: z.string() }),
      },
    }),
    async (c) => {
      // both validators must pass, so the validated input is the intersection
      const body = c.req.valid('json');
      expectTypeOf(body.name).toEqualTypeOf<string>();
      expectTypeOf(body.email).toEqualTypeOf<string>();

      // declared payloads of both operations stay typed
      c.var.res(400, { second: 'x' });
      // @ts-expect-error 200 is not declared in the second operation's own schema
      c.var.res(200, { second: 'x' });
      // @ts-expect-error wrong payload type for the 400 response
      c.var.res(400, { second: 123 });

      return c.var.res(200, { first: 'ok' });
    },
  );
});

/**
 * Incompatible middleware environments: Hoon merges middleware environments
 * structurally (this is Hono's own behavior for plain chaining, verified
 * separately), so an env that is structurally incompatible with the app does
 * not produce an error at the `openApi()` call site. What IS enforced is that a
 * middleware's declared env is trustworthy inside the middleware itself (see
 * the `@ts-expect-error` above) and that app bindings survive in the handler.
 */
it('handler env stays precise even with an env-mismatched middleware', () => {
  const mismatched = createMiddleware<{ Bindings: { WRONG: boolean } }>(
    async (c, next) => {
      expectTypeOf(c.env.WRONG).toEqualTypeOf<boolean>();
      await next();
    },
  );

  const app = new Hono<AppEnv>().post(
    '/whatever',
    openApi(
      {
        responses: {
          200: z.object({ ok: z.boolean() }),
        },
      },
      mismatched,
    ),
    async (c) => {
      expectTypeOf(c.env.KV).toEqualTypeOf<AppBindings['KV']>();
      return c.json({ ok: true }, 200);
    },
  );
  expectTypeOf(app).not.toBeUndefined();
});

describe('createOpenApiFragment', () => {
  type FragmentEnv = {
    Bindings: { SESSIONS: Map<string, string> };
    Variables: { userId: string };
  };
  const openApiFragment = createOpenApiFragment<FragmentEnv>();

  const fragmentRoutes = new Hono<FragmentEnv>()
    .post(
      '/user',
      openApiFragment(
        {
          responses: {
            200: z.object({ name: z.string() }),
            401: { schema: z.object({ message: z.string() }) },
          },
          request: {
            header: z.object({ Authorization: z.string() }),
            json: z.object({ name: z.string() }),
          },
        },
        // inline middleware — everything contextually typed, zero annotations
        async (c, next) => {
          expectTypeOf(c.env.SESSIONS).toEqualTypeOf<
            FragmentEnv['Bindings']['SESSIONS']
          >();
          expectTypeOf(c.req.valid('header')).toEqualTypeOf<{
            Authorization: string;
          }>();
          expectTypeOf(c.var.res(401, { message: 'no' })).toEqualTypeOf<
            Response & TypedResponse<{ message: string }, 401, 'json'>
          >();

          // @ts-expect-error the middleware env is precise: unknown bindings are rejected
          const _unknownBinding = c.env.NOT_A_REAL_BINDING;
          // @ts-expect-error only declared request targets are accepted
          const _invalidTarget = c.req.valid('query');
          // @ts-expect-error wrong payload shape for the 401 response
          c.var.res(401, { message: 123 });

          if (
            !(await c.env.SESSIONS.get(c.req.valid('header').Authorization))
          ) {
            return c.var.res(401, { message: 'Unauthorized' });
          }
          await next();
        },
      ),
      async (c) => {
        expectTypeOf(c.var.userId).toEqualTypeOf<string>();
        return c.var.res(200, { name: 'John' });
      },
    )
    .get(
      '/plain',
      openApiFragment({ responses: { 200: z.object({ a: z.string() }) } }),
      (c) => c.var.res(200, { a: 'x' }),
    );

  it('incompatible environments are rejected at the fragment slot', () => {
    const wrongEnv = createMiddleware<{ Bindings: { WRONG: true } }>(
      async (c, next) => {
        expectTypeOf(c.env.WRONG).toEqualTypeOf<true>();
        await next();
      },
    );

    const composed = openApiFragment(
      { responses: { 200: z.object({}) } },
      // @ts-expect-error incompatible middleware environments must be rejected
      wrongEnv,
    );
    expectTypeOf(composed).not.toBeUndefined();
  });

  it('fragment routes keep hc<AppType> inference (200 + middleware 401 + plain routes)', () => {
    const client = hc<typeof fragmentRoutes>('/');
    expectTypeOf<
      InferRequestType<typeof client.user.$post>['json']
    >().toEqualTypeOf<{
      name: string;
    }>();
    const run = async () => {
      const res = await client.user.$post({
        json: { name: 'x' },
        header: { Authorization: 't' },
      });
      if (res.status === 200) {
        expectTypeOf(await res.json()).toEqualTypeOf<{ name: string }>();
      }
      if (res.status === 401) {
        expectTypeOf(await res.json()).toEqualTypeOf<{ message: string }>();
      }
      const plain = await client.plain.$get();
      if (plain.status === 200) {
        expectTypeOf(await plain.json()).toEqualTypeOf<{ a: string }>();
      }
    };
    expectTypeOf(run).not.toBeUndefined();
  });

  it('fragment arity-0 route keeps the seeded app env in the handler', () => {
    const app = new Hono<FragmentEnv>().post(
      '/zero',
      openApiFragment({
        responses: {
          200: z.object({ ok: z.boolean() }),
        },
      }),
      async (c) => {
        expectTypeOf(c.env.SESSIONS).toEqualTypeOf<
          FragmentEnv['Bindings']['SESSIONS']
        >();
        return c.json({ ok: true }, 200);
      },
    );
    expectTypeOf(app).not.toBeUndefined();
  });
});

describe('fragment conflict checking', () => {
  it('same json target with a different schema is rejected statically', () => {
    const fragment = openApi({
      request: { json: z.object({ name: z.string() }) },
      responses: { 200: z.object({ name: z.string() }) },
    });

    const _bad = openApi(
      {
        request: { json: z.object({ age: z.number() }) },
        responses: { 200: z.object({ name: z.string() }) },
      },
      // @ts-expect-error route declares json with a different schema → conflict
      fragment,
    );
    expectTypeOf(_bad).not.toBeUndefined();
  });

  it('same status with a different schema is rejected statically', () => {
    const fragment = openApi({
      responses: { 200: z.object({ name: z.string() }) },
    });

    const _bad2 = openApi(
      { responses: { 200: z.object({ greeting: z.string() }) } },
      // @ts-expect-error route declares 200 with a different schema → conflict
      fragment,
    );
    expectTypeOf(_bad2).not.toBeUndefined();
  });

  it('identical schemas for the same keys are allowed', () => {
    const schema = z.object({ name: z.string() });
    const fragment = openApi({
      request: { json: schema },
      responses: { 200: schema },
    });

    const composed = openApi(
      {
        request: { json: z.object({ name: z.string() }) },
        responses: { 200: z.object({ name: z.string() }) },
      },
      fragment,
    );
    expectTypeOf(composed).not.toBeUndefined();
  });

  it('disjoint fragments compose without errors', () => {
    const authFragment = openApi({
      request: { header: z.object({ authorization: z.string() }) },
      responses: { 401: z.object({ message: z.string() }) },
    });

    const composed = openApi(
      {
        request: { json: z.object({ name: z.string() }) },
        responses: { 200: z.object({ name: z.string() }) },
      },
      authFragment,
    );
    expectTypeOf(composed).not.toBeUndefined();
  });

  it('nested fragments keep merged client inference', () => {
    const authFragment = openApi({
      responses: { 401: z.object({ message: z.string() }) },
    });

    const routes = new Hono().post(
      '/user',
      openApi(
        {
          request: { json: z.object({ name: z.string() }) },
          responses: { 200: z.object({ name: z.string() }) },
        },
        authFragment,
      ),
      (c) => c.json(c.req.valid('json'), 200),
    );

    const client = hc<typeof routes>('/');
    const run = async () => {
      const res = await client.user.$post({ json: { name: 'x' } });
      if (res.status === 200) {
        expectTypeOf(await res.json()).toEqualTypeOf<{ name: string }>();
      }
      if (res.status === 401) {
        expectTypeOf(await res.json()).toEqualTypeOf<{ message: string }>();
      }
    };
    expectTypeOf(run).not.toBeUndefined();
  });
});
