import type {
  Env,
  MiddlewareHandler,
  TypedResponse,
  ValidationTargets as ValidationTargetsWithForm,
} from 'hono';
import type { HandlerResponse, IntersectNonAnyTypes } from 'hono/types';
import type {
  FragmentShapeSymbol,
  RequestValidationSchemaSymbol,
} from './symbols.ts';
import type { ResponseHeader } from 'hono/utils/headers';
import type { ContentlessStatusCode, StatusCode } from 'hono/utils/http-status';
import type { BaseMime } from 'hono/utils/mime';
import type * as z from 'zod';
import type {
  ZodOpenApiObject,
  ZodOpenApiOperationObject,
  ZodOpenApiResponseObject,
} from 'zod-openapi';

export type ValidationTarget = 'json' | 'query' | 'param' | 'cookie' | 'header';
type RequestParam = ValidationTarget;
type ValidationSchemas = Partial<Record<ValidationTarget, z.ZodType>>;
type ValidationTargets = Omit<ValidationTargetsWithForm, 'form'>;

export type ValidationTargetParams<T extends z.ZodType> = {
  /**
   * Zod schema for the target.
   */
  schema: T;
  /**
   * Determines whether the target should be validated or if the schema should only be used for documentation.
   * @default true
   */
  validate?: boolean;
  /** @internal Runtime schema when the documented schema includes doc-only fields. */
  [RequestValidationSchemaSymbol]?: z.ZodType;
};

type StatusCodePrefix = '1' | '2' | '3' | '4' | '5';
export type StatusCodeWithoutMinus1 = Exclude<StatusCode, -1>;
export type StatusCodeWithWildcards =
  | StatusCodeWithoutMinus1
  | `${StatusCodePrefix}XX`
  | 'default';

// Check if a key is a wildcard or 'default'
type IsWildcardOrDefault<K> = K extends 'default'
  ? true
  : K extends `${StatusCodePrefix}XX`
    ? true
    : false;

// Contentless status codes (204, 205, 304) don't require a schema
type IsContentlessStatusCode<K> = K extends ContentlessStatusCode
  ? true
  : false;

/**
 * Mapping of zod-validator targets to their respective schemas, used both as a source of truth
 * for validation and for OpenAPI documentation.
 */
export type HonoOpenApiRequestSchemas = Partial<
  Record<RequestParam, ValidationTargetParams<z.ZodType> | z.ZodType>
>;

export type Method = 'get' | 'put' | 'post' | 'delete' | 'options' | 'patch';
export type NormalizedRequestSchemas = Partial<Record<RequestParam, z.ZodType>>;
type HasUndefined<T> = undefined extends T ? true : false;
type IsUnknown<T> = unknown extends T
  ? [T] extends [null]
    ? false
    : true
  : false;
type Clean<T> = {
  [K in keyof T as T[K] extends never ? never : K]: T[K];
} & {};

type ExtractInValues<
  Schema extends z.ZodType,
  Target extends keyof Omit<ValidationTargets, 'form'>,
  In = z.input<Schema>,
> =
  HasUndefined<In> extends true
    ? In extends ValidationTargets[Target]
      ? In
      : { [K2 in keyof In]?: ValidationTargets[Target][K2] }
    : In extends ValidationTargets[Target]
      ? In
      : { [K2 in keyof In]: ValidationTargets[Target][K2] };

type GetValidationSchemas<T extends HonoOpenApiRequestSchemas> = Clean<{
  [K in keyof T]: T[K] extends ValidationTargetParams<infer S>
    ? T[K]['validate'] extends false
      ? never
      : S
    : T[K] extends z.ZodType
      ? T[K]
      : never;
}>;

type ToValidatorValues<T extends ValidationSchemas> = {
  in: Clean<{
    [K in keyof ValidationTargets]: IsUnknown<T[K]> extends true
      ? never
      : ExtractInValues<Exclude<T[K], undefined>, K>;
  }>;
  out: Clean<{
    [K in keyof ValidationTargets]: IsUnknown<T[K]> extends true
      ? never
      : z.output<Exclude<T[K], undefined>>;
  }>;
};

export type Values<T extends HonoOpenApiRequestSchemas> = ToValidatorValues<
  GetValidationSchemas<T>
>;

type MergeValueTarget<A, B> =
  A extends Record<string, never>
    ? B
    : B extends Record<string, never>
      ? A
      : A & B;

type MergeValueMaps<A, B> = Clean<{
  [K in keyof A | keyof B]: K extends keyof A
    ? K extends keyof B
      ? MergeValueTarget<A[K], B[K]>
      : A[K]
    : K extends keyof B
      ? B[K]
      : never;
}>;

/** Merge validated inputs/outputs by target, ignoring empty object schemas. */
type MergeRequestValues<A, B> = A extends { in: infer AIn; out: infer AOut }
  ? B extends { in: infer BIn; out: infer BOut }
    ? {
        in: MergeValueMaps<AIn, BIn>;
        out: MergeValueMaps<AOut, BOut>;
      }
    : never
  : never;

export type ZodValidatorFn = <
  S extends z.ZodType,
  T extends keyof ValidationTargets,
>(
  target: T,
  schema: S,
  // oxlint-disable-next-line no-explicit-any, no-empty-object-type
) => MiddlewareHandler<any, string, {}, any>;

export type EndpointDetails = Omit<
  ZodOpenApiOperationObject,
  'responses' | 'requestBody' | 'requestParams'
>;

export interface ReferenceObject {
  $ref: string;
  summary?: string;
  description?: string;
}

interface SimpleResponseObject extends Pick<
  ZodOpenApiResponseObject,
  'links' | 'headers' | 'id'
> {
  description?: string;
  schema: z.ZodType;
  mediaType?: string;
}

/**
 * OpenAPI response object, augmented with Zod-based schema.
 */
export type HonoOpenApiResponseObject =
  | ZodOpenApiResponseObject
  | SimpleResponseObject
  | z.ZodType
  | ReferenceObject;

export type HonoOpenApiResponses = Partial<
  Record<StatusCodeWithWildcards, HonoOpenApiResponseObject>
>;

/**
 * OpenAPI operation object, augmented with Zod-based request and response schemas.
 * See README for exhaustive set of examples.
 */
export interface HonoOpenApiOperation<
  Req extends HonoOpenApiRequestSchemas = HonoOpenApiRequestSchemas,
  Res extends HonoOpenApiResponses = HonoOpenApiResponses,
> extends Omit<ZodOpenApiOperationObject, 'requestParams' | 'responses'> {
  request?: Req;
  responses: Res;
}

/**
 * zod-openapi document without `openapi` property (set to 3.1.0, we do not support lower versions).
 * @see https://swagger.io/specification/
 */
export type HonoOpenApiDocument = Omit<ZodOpenApiObject, 'openapi'>;

/**
 * The `openApi` middleware, optionally accepting reusable user middleware.
 *
 * When middleware is passed, the returned middleware composes them after the
 * request validators and the typed-response middleware, and its environment is
 * the intersection of the route environment (inferred from the passed
 * middleware) and this library's `res` helper environment. Responses declared
 * as `TypedResponse` by the passed middleware are merged into the route's
 * Hono RPC client schema.
 *
 * @example
 * ```ts
 * app.post('/user', openApi(operation), handler); // pre-existing usage
 * app.post(
 *   '/user',
 *   openApi(
 *     operation,
 *     auth, // MiddlewareHandler<AppEnv, string, {}, TypedResponse<...>>
 *   ),
 *   handler,
 * );
 * ```
 */
export interface HonoOpenApiMiddleware {
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<HonoOpenApiMiddlewareEnv<Res>, P, Values<Req>>
  >;

  /**
   * Compose a previously created `openApi` fragment into this operation.
   * Request object properties are merged; overlapping properties with a
   * different output schema are rejected. A response status may be repeated
   * only when its schema matches. The combined operation validates each
   * request target once.
   */
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    FReq extends HonoOpenApiRequestSchemas,
    FRes extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragmentMiddleware: OpenApiFragmentValue<FReq, FRes> &
      OpenApiShapeConflict<Req, FReq, Res, FRes>,
  ): OpenApiFragmentValue<
    Req & FReq,
    Res & FRes,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [HonoOpenApiMiddlewareEnv<Res>, HonoOpenApiMiddlewareEnv<FRes>]
      >,
      P,
      MergeRequestValues<Values<Req>, Values<FReq>>,
      OperationResponseTypes<Res> | OperationResponseTypes<FRes>
    >
  >;

  /** Compose two fragments into an operation, checking conflicts cumulatively. */
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    F1Req extends HonoOpenApiRequestSchemas,
    F1Res extends HonoOpenApiResponses,
    F2Req extends HonoOpenApiRequestSchemas,
    F2Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragment1: OpenApiFragmentValue<F1Req, F1Res> &
      OpenApiShapeConflict<Req, F1Req, Res, F1Res>,
    fragment2: OpenApiFragmentValue<F2Req, F2Res> &
      OpenApiShapeConflict<Req & F1Req, F2Req, Res & F1Res, F2Res>,
  ): OpenApiFragmentValue<
    Req & F1Req & F2Req,
    Res & F1Res & F2Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [
          HonoOpenApiMiddlewareEnv<Res>,
          HonoOpenApiMiddlewareEnv<F1Res>,
          HonoOpenApiMiddlewareEnv<F2Res>,
        ]
      >,
      P,
      MergeRequestValues<
        MergeRequestValues<Values<Req>, Values<F1Req>>,
        Values<F2Req>
      >,
      | OperationResponseTypes<Res>
      | OperationResponseTypes<F1Res>
      | OperationResponseTypes<F2Res>
    >
  >;

  /** Compose three fragments into an operation, checking conflicts cumulatively. */
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    F1Req extends HonoOpenApiRequestSchemas,
    F1Res extends HonoOpenApiResponses,
    F2Req extends HonoOpenApiRequestSchemas,
    F2Res extends HonoOpenApiResponses,
    F3Req extends HonoOpenApiRequestSchemas,
    F3Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragment1: OpenApiFragmentValue<F1Req, F1Res> &
      OpenApiShapeConflict<Req, F1Req, Res, F1Res>,
    fragment2: OpenApiFragmentValue<F2Req, F2Res> &
      OpenApiShapeConflict<Req & F1Req, F2Req, Res & F1Res, F2Res>,
    fragment3: OpenApiFragmentValue<F3Req, F3Res> &
      OpenApiShapeConflict<
        Req & F1Req & F2Req,
        F3Req,
        Res & F1Res & F2Res,
        F3Res
      >,
  ): OpenApiFragmentValue<
    Req & F1Req & F2Req & F3Req,
    Res & F1Res & F2Res & F3Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [
          HonoOpenApiMiddlewareEnv<Res>,
          HonoOpenApiMiddlewareEnv<F1Res>,
          HonoOpenApiMiddlewareEnv<F2Res>,
          HonoOpenApiMiddlewareEnv<F3Res>,
        ]
      >,
      P,
      MergeRequestValues<
        MergeRequestValues<
          MergeRequestValues<Values<Req>, Values<F1Req>>,
          Values<F2Req>
        >,
        Values<F3Req>
      >,
      | OperationResponseTypes<Res>
      | OperationResponseTypes<F1Res>
      | OperationResponseTypes<F2Res>
      | OperationResponseTypes<F3Res>
    >
  >;

  <
    // oxlint-disable-next-line no-explicit-any
    X1 extends HandlerResponse<any>,
    E1 extends Env,
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    // oxlint-disable-next-line no-explicit-any
    middleware1: MiddlewareHandler<E1, P, any, X1> & {
      [FragmentShapeSymbol]?: never;
    },
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<[E1, HonoOpenApiMiddlewareEnv<Res>]>,
      P,
      Values<Req>,
      X1
    >
  >;

  <
    // oxlint-disable-next-line no-explicit-any
    X1 extends HandlerResponse<any>,
    // oxlint-disable-next-line no-explicit-any
    X2 extends HandlerResponse<any>,
    E1 extends Env,
    E2 extends Env,
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    // oxlint-disable-next-line no-explicit-any
    middleware1: MiddlewareHandler<E1, P, any, X1> & {
      [FragmentShapeSymbol]?: never;
    },
    // oxlint-disable-next-line no-explicit-any
    middleware2: MiddlewareHandler<E2, P, any, X2>,
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<[E1, E2, HonoOpenApiMiddlewareEnv<Res>]>,
      P,
      Values<Req>,
      X1 | X2
    >
  >;

  <
    // oxlint-disable-next-line no-explicit-any
    X1 extends HandlerResponse<any>,
    // oxlint-disable-next-line no-explicit-any
    X2 extends HandlerResponse<any>,
    // oxlint-disable-next-line no-explicit-any
    X3 extends HandlerResponse<any>,
    E1 extends Env,
    E2 extends Env,
    E3 extends Env,
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    // oxlint-disable-next-line no-explicit-any
    middleware1: MiddlewareHandler<E1, P, any, X1> & {
      [FragmentShapeSymbol]?: never;
    },
    // oxlint-disable-next-line no-explicit-any
    middleware2: MiddlewareHandler<E2, P, any, X2>,
    // oxlint-disable-next-line no-explicit-any
    middleware3: MiddlewareHandler<E3, P, any, X3>,
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<[E1, E2, E3, HonoOpenApiMiddlewareEnv<Res>]>,
      P,
      Values<Req>,
      X1 | X2 | X3
    >
  >;
}

/**
 * `TypedResponse` union implied by an operation's declared responses.
 * Used as the default response type for middleware that do not declare their
 * own, so early responses typed with the operation's schema surface in the
 * Hono RPC client.
 */
type ExtractTypedMiddlewareResponseOnly<T> = T extends TypedResponse
  ? T
  : never;

/* AnyMiddleware mirrors Hono's own middleware generics (default is `any`). */
// oxlint-disable-next-line typescript/no-explicit-any
type AnyMiddleware = MiddlewareHandler<any, any, any, any>;
// oxlint-disable-next-line typescript/no-explicit-any
type AnyTypedResponse = TypedResponse<any, any, any>;
// the unparameterized z.ZodType base used by blank request records; not comparable
// oxlint-disable-next-line typescript/no-explicit-any
type AnyZodSchema = z.ZodType<any, any, any>;

/**
 * `TypedResponse` members a Hono middleware contributes to a route, mirroring
 * Hono's internal `MergeMiddlewareResponse`.
 */
export type HonoMiddlewareTypedResponses<M extends AnyMiddleware> = M extends (
  c: unknown,
  next: unknown,
) => Promise<infer R>
  ? Exclude<R, void> extends never
    ? never
    : Exclude<R, void> extends Response | AnyTypedResponse
      ? ExtractTypedMiddlewareResponseOnly<Exclude<R, void>>
      : never
  : M extends (c: unknown, next: unknown) => infer R
    ? R extends Response | AnyTypedResponse
      ? ExtractTypedMiddlewareResponseOnly<R>
      : never
    : never;

/**
 * Middleware value created by `openApi()` / `createOpenApiFragment()`.
 * Carries the operation's declared shapes so fragments can be composed and
 * statically checked for conflicting schemas.
 */
export type OpenApiFragmentValue<
  FReq extends HonoOpenApiRequestSchemas,
  FRes extends HonoOpenApiResponses,
  Mw extends AnyMiddleware = AnyMiddleware,
> = Mw & {
  readonly [FragmentShapeSymbol]: {
    readonly request?: FReq;
    readonly responses: FRes;
  };
};

/**
 * Type for a parameter that cannot be satisfied — used by fragment slots to
 * statically reject conflicting fragments.
 */
export type OpenApiFragmentConflictError<Details extends string = string> = {
  readonly 'openApi fragment conflict': Details;
};

type SchemaOfTarget<T> =
  T extends ValidationTargetParams<infer S>
    ? S
    : T extends AnyZodSchema
      ? T
      : never;

// internal aliases used by type tests to inspect intermediate steps
export type SchemaOfTargetInternal<T> = SchemaOfTarget<T>;
export type ConcreteSchemaOutInternal<T extends AnyZodSchema> =
  ConcreteSchemaOut<T>;
export type EqualInternal<A, B> = Equal<A, B>;

// schemas whose validated output is not a concrete shape (e.g. the bare
// `z.ZodType` used by blank request records, `z.any()`) cannot be conflicting
type ConcreteSchemaOut<T extends AnyZodSchema> =
  z.output<T> extends never
    ? never
    : unknown extends z.output<T>
      ? never
      : z.output<T>;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type ConflictingKeys<Req, FReq> = {
  [K in keyof Req & keyof FReq]: ConcreteSchemaOut<
    Extract<SchemaOfTarget<Req[K]>, AnyZodSchema>
  > extends never
    ? never
    : ConcreteSchemaOut<
          Extract<SchemaOfTarget<FReq[K]>, AnyZodSchema>
        > extends never
      ? never
      : Equal<
            z.output<Extract<SchemaOfTarget<Req[K]>, AnyZodSchema>>,
            z.output<Extract<SchemaOfTarget<FReq[K]>, AnyZodSchema>>
          > extends true
        ? never
        : K;
}[keyof Req & keyof FReq];

type ObjectShape<T> = T extends z.ZodObject<infer Shape> ? Shape : never;
type PropertyConflicts<A, B> = {
  [K in keyof A & keyof B]: Equal<z.output<A[K]>, z.output<B[K]>> extends true
    ? never
    : K;
}[keyof A & keyof B];
type ConflictingRequestKeys<Req, FReq> = {
  [K in keyof Req & keyof FReq]: ObjectShape<
    Extract<SchemaOfTarget<Req[K]>, AnyZodSchema>
  > extends infer A
    ? [A] extends [never]
      ? ConflictingKeys<Pick<Req, K>, Pick<FReq, K>> extends never
        ? never
        : K
      : ObjectShape<
            Extract<SchemaOfTarget<FReq[K]>, AnyZodSchema>
          > extends infer B
        ? [B] extends [never]
          ? ConflictingKeys<Pick<Req, K>, Pick<FReq, K>> extends never
            ? never
            : K
          : PropertyConflicts<A, B> extends never
            ? never
            : `${K & string}.${PropertyConflicts<A, B> & string}`
        : never
    : never;
}[keyof Req & keyof FReq];

type DeclaredResponseSchema<T> = ExtractResponseSchema<T>;
type SameResponseSchema<A, B> = [DeclaredResponseSchema<A>] extends [never]
  ? [DeclaredResponseSchema<B>] extends [never]
    ? A extends ReferenceObject
      ? B extends ReferenceObject
        ? Equal<A['$ref'], B['$ref']>
        : false
      : false
    : false
  : [DeclaredResponseSchema<B>] extends [never]
    ? false
    : Equal<
        z.output<Extract<DeclaredResponseSchema<A>, z.ZodType>>,
        z.output<Extract<DeclaredResponseSchema<B>, z.ZodType>>
      >;
type ConflictingResponseStatuses<Res, FRes> = {
  [Status in keyof Res & keyof FRes]: SameResponseSchema<
    Res[Status],
    FRes[Status]
  > extends true
    ? never
    : Status;
}[keyof Res & keyof FRes];

/**
 * Whether a fragment middleware may be composed into an operation without
 * conflicting request properties or a repeated response status with a
 * different schema. Request object schemas may declare disjoint properties on
 * the same target.
 */
export type OpenApiShapeConflicts<
  Req extends HonoOpenApiRequestSchemas,
  FReq extends HonoOpenApiRequestSchemas,
  Res extends HonoOpenApiResponses,
  FRes extends HonoOpenApiResponses,
> = [OpenApiShapeConflictDetails<Req, FReq, Res, FRes>] extends [never]
  ? true
  : false;

type RequestConflictMessage<Conflict> = Conflict extends string
  ? `request property "${Conflict}" has an incompatible schema`
  : never;
type ResponseConflictMessage<Status> = Status extends string | number
  ? `response status "${Status}" has a different schema`
  : never;

export type OpenApiShapeConflictDetails<
  Req extends HonoOpenApiRequestSchemas,
  FReq extends HonoOpenApiRequestSchemas,
  Res extends HonoOpenApiResponses,
  FRes extends HonoOpenApiResponses,
> =
  | RequestConflictMessage<ConflictingRequestKeys<Req, FReq>>
  | ResponseConflictMessage<ConflictingResponseStatuses<Res, FRes>>;

export type OpenApiShapeConflict<
  Req extends HonoOpenApiRequestSchemas,
  FReq extends HonoOpenApiRequestSchemas,
  Res extends HonoOpenApiResponses,
  FRes extends HonoOpenApiResponses,
> = [OpenApiShapeConflictDetails<Req, FReq, Res, FRes>] extends [never]
  ? unknown
  : OpenApiFragmentConflictError<
      OpenApiShapeConflictDetails<Req, FReq, Res, FRes>
    >;

export type OperationResponseTypes<Res extends HonoOpenApiResponses> =
  keyof ResponseSchemas<Res> extends never
    ? Response
    : {
        [S in keyof ResponseSchemas<Res>]: TypedResponse<
          InferPayload<ResponseSchemas<Res>[S]>,
          S & StatusCodeWithoutMinus1
        >;
      }[keyof ResponseSchemas<Res>];

/**
 * Middleware shape accepted by a fragment: the fragment's seeded environment
 * (route environment intersected with the `res` helper environment) and the
 * operation's validated-input types.
 */
export type FragmentMiddlewareBase<
  RouteEnv extends Env,
  Res extends HonoOpenApiResponses,
  P extends string,
  Req extends HonoOpenApiRequestSchemas,
> = MiddlewareHandler<
  IntersectNonAnyTypes<[RouteEnv, HonoOpenApiMiddlewareEnv<Res>]>,
  P,
  Values<Req>
>;

export type FragmentEnv<
  RouteEnv extends Env,
  Res extends HonoOpenApiResponses,
> = IntersectNonAnyTypes<[RouteEnv, HonoOpenApiMiddlewareEnv<Res>]>;

/**
 * Call signatures of the creator returned by {@link createOpenApiFragment}.
 *
 * Every middleware slot carries the fragment's seeded environment (app
 * bindings/variables intersected with the `res` helper environment) and the
 * validated-input types derived from the operation, so middleware written
 * inline get `c.env`, `c.req.valid()` and `c.var.res()` typed without extra
 * annotations. Middleware annotated with their own environment are accepted as
 * well when it is compatible with the seeded environment. Responses declared as
 * `TypedResponse` by the passed middleware are merged into the route's Hono RPC
 * client schema.
 */
export interface HonoOpenApiFragmentMiddleware<RouteEnv extends Env> {
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      FragmentEnv<RouteEnv, Res>,
      P,
      Values<Req>,
      OperationResponseTypes<Res>
    >
  >;

  <
    FReq extends HonoOpenApiRequestSchemas,
    FRes extends HonoOpenApiResponses,
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragmentMiddleware: OpenApiFragmentValue<FReq, FRes> &
      OpenApiShapeConflict<Req, FReq, Res, FRes>,
  ): OpenApiFragmentValue<
    Req & FReq,
    Res & FRes,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [FragmentEnv<RouteEnv, Res>, HonoOpenApiMiddlewareEnv<FRes>]
      >,
      P,
      MergeRequestValues<Values<Req>, Values<FReq>>,
      OperationResponseTypes<Res> | OperationResponseTypes<FRes>
    >
  >;

  /** Compose two fragments, checking conflicts against the accumulated shape. */
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    F1Req extends HonoOpenApiRequestSchemas,
    F1Res extends HonoOpenApiResponses,
    F2Req extends HonoOpenApiRequestSchemas,
    F2Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragment1: OpenApiFragmentValue<F1Req, F1Res> &
      OpenApiShapeConflict<Req, F1Req, Res, F1Res>,
    fragment2: OpenApiFragmentValue<F2Req, F2Res> &
      OpenApiShapeConflict<Req & F1Req, F2Req, Res & F1Res, F2Res>,
  ): OpenApiFragmentValue<
    Req & F1Req & F2Req,
    Res & F1Res & F2Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [
          FragmentEnv<RouteEnv, Res>,
          HonoOpenApiMiddlewareEnv<F1Res>,
          HonoOpenApiMiddlewareEnv<F2Res>,
        ]
      >,
      P,
      MergeRequestValues<
        MergeRequestValues<Values<Req>, Values<F1Req>>,
        Values<F2Req>
      >,
      | OperationResponseTypes<Res>
      | OperationResponseTypes<F1Res>
      | OperationResponseTypes<F2Res>
    >
  >;

  /** Compose three fragments, checking conflicts against the accumulated shape. */
  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    F1Req extends HonoOpenApiRequestSchemas,
    F1Res extends HonoOpenApiResponses,
    F2Req extends HonoOpenApiRequestSchemas,
    F2Res extends HonoOpenApiResponses,
    F3Req extends HonoOpenApiRequestSchemas,
    F3Res extends HonoOpenApiResponses,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    fragment1: OpenApiFragmentValue<F1Req, F1Res> &
      OpenApiShapeConflict<Req, F1Req, Res, F1Res>,
    fragment2: OpenApiFragmentValue<F2Req, F2Res> &
      OpenApiShapeConflict<Req & F1Req, F2Req, Res & F1Res, F2Res>,
    fragment3: OpenApiFragmentValue<F3Req, F3Res> &
      OpenApiShapeConflict<
        Req & F1Req & F2Req,
        F3Req,
        Res & F1Res & F2Res,
        F3Res
      >,
  ): OpenApiFragmentValue<
    Req & F1Req & F2Req & F3Req,
    Res & F1Res & F2Res & F3Res,
    MiddlewareHandler<
      IntersectNonAnyTypes<
        [
          FragmentEnv<RouteEnv, Res>,
          HonoOpenApiMiddlewareEnv<F1Res>,
          HonoOpenApiMiddlewareEnv<F2Res>,
          HonoOpenApiMiddlewareEnv<F3Res>,
        ]
      >,
      P,
      MergeRequestValues<
        MergeRequestValues<
          MergeRequestValues<Values<Req>, Values<F1Req>>,
          Values<F2Req>
        >,
        Values<F3Req>
      >,
      | OperationResponseTypes<Res>
      | OperationResponseTypes<F1Res>
      | OperationResponseTypes<F2Res>
      | OperationResponseTypes<F3Res>
    >
  >;

  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    M1 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    middleware1: M1 & { [FragmentShapeSymbol]?: never },
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      FragmentEnv<RouteEnv, Res>,
      P,
      Values<Req>,
      HonoMiddlewareTypedResponses<M1> | OperationResponseTypes<Res>
    >
  >;

  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    M1 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
    M2 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    middleware1: M1 & { [FragmentShapeSymbol]?: never },
    middleware2: M2 & { [FragmentShapeSymbol]?: never },
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      FragmentEnv<RouteEnv, Res>,
      P,
      Values<Req>,
      | HonoMiddlewareTypedResponses<M1>
      | HonoMiddlewareTypedResponses<M2>
      | OperationResponseTypes<Res>
    >
  >;

  <
    Req extends HonoOpenApiRequestSchemas,
    P extends string,
    Res extends HonoOpenApiResponses,
    M1 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
    M2 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
    M3 extends FragmentMiddlewareBase<RouteEnv, Res, P, Req> =
      FragmentMiddlewareBase<RouteEnv, Res, P, Req>,
  >(
    operation: HonoOpenApiOperation<Req, Res>,
    middleware1: M1 & { [FragmentShapeSymbol]?: never },
    middleware2: M2 & { [FragmentShapeSymbol]?: never },
    middleware3: M3 & { [FragmentShapeSymbol]?: never },
  ): OpenApiFragmentValue<
    Req,
    Res,
    MiddlewareHandler<
      FragmentEnv<RouteEnv, Res>,
      P,
      Values<Req>,
      | HonoMiddlewareTypedResponses<M1>
      | HonoMiddlewareTypedResponses<M2>
      | HonoMiddlewareTypedResponses<M3>
      | OperationResponseTypes<Res>
    >
  >;
}

type ExtractResponseSchema<T> = T extends SimpleResponseObject
  ? T['schema']
  : T extends ZodOpenApiResponseObject
    ? T['content'] extends Record<string, { schema: z.ZodType }>
      ? T['content'][keyof T['content']]['schema']
      : never
    : T extends z.ZodType
      ? T
      : never;

export type ResponseSchemas<T extends HonoOpenApiResponses> = {
  [S in keyof T as IsWildcardOrDefault<S> extends true
    ? never
    : IsContentlessStatusCode<S> extends true
      ? S
      : ExtractResponseSchema<T[S]> extends never
        ? never
        : S]: IsContentlessStatusCode<S> extends true
    ? null
    : ExtractResponseSchema<T[S]>;
};

export type HeaderRecord = Record<string, string | string[]> & {
  'Content-Type'?: BaseMime;
} & Partial<Record<ResponseHeader, string | string[]>>;

type InferPayload<T> = T extends null ? null : z.infer<T>;

type ResWithStatus<
  Schemas extends Partial<Record<StatusCodeWithoutMinus1, unknown>>,
> = <S extends keyof Schemas & StatusCodeWithoutMinus1>(
  status: S,
  payload: InferPayload<Schemas[S]>,
  headers?: HeaderRecord,
) => Response & TypedResponse<InferPayload<Schemas[S]>, S>;

type ResWithoutStatus<
  Schemas extends Partial<Record<StatusCodeWithoutMinus1, unknown>>,
> = Schemas extends { 200: infer T }
  ? (
      payload: z.infer<T>,
      headers?: HeaderRecord,
    ) => Response & TypedResponse<z.infer<T>, 200, 'json'>
  : // oxlint-disable-next-line typescript/no-empty-object-type
    {};

export type HonoOpenApiMiddlewareEnv<
  Res extends HonoOpenApiResponses,
  Schemas extends Partial<Record<StatusCodeWithoutMinus1, unknown>> =
    ResponseSchemas<Res>,
> = {
  Variables: {
    res: ResWithStatus<Schemas> & ResWithoutStatus<Schemas>;
  };
};

export type ResponseSchema = {
  status: string;
  schema: z.ZodType | null;
  contentType: string | null;
};
