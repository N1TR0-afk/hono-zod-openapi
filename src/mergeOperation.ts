import * as z from 'zod';
import { RequestValidationSchemaSymbol } from './symbols.ts';
import type {
  HonoOpenApiOperation,
  HonoOpenApiRequestSchemas,
  HonoOpenApiResponses,
} from './types.ts';

const ARRAY_KEYS = [
  'tags',
  'security',
  'parameters',
  'servers',
  'callbacks',
] as const;

type ArrayKey = (typeof ARRAY_KEYS)[number];

const dedupe = <T>(values: T[]): T[] => {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};

const mergeArrays = (a: unknown, b: unknown): unknown => {
  if (!Array.isArray(a)) return b;
  if (!Array.isArray(b)) return a;
  return dedupe([...a, ...b]);
};

const mergeObjects = (a: unknown, b: unknown): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    ...((a && typeof a === 'object' ? a : {}) as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(
    (b && typeof b === 'object' ? b : {}) as Record<string, unknown>,
  )) {
    // keep the later value unless it is undefined (does not clear the earlier one)
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

const mergeResponses = (
  a: HonoOpenApiResponses | undefined,
  b: HonoOpenApiResponses | undefined,
): HonoOpenApiResponses => ({
  ...a,
  ...b,
});

const mergeRequests = (
  a: HonoOpenApiRequestSchemas | undefined,
  b: HonoOpenApiRequestSchemas | undefined,
): HonoOpenApiRequestSchemas => {
  const merged = { ...a, ...b };
  for (const target of Object.keys(a ?? {}) as Array<
    keyof HonoOpenApiRequestSchemas
  >) {
    if (!(target in (b ?? {}))) continue;

    const first = a?.[target];
    const second = b?.[target];
    if (!first || !second) continue;

    const firstSchema = first instanceof z.ZodType ? first : first.schema;
    const secondSchema = second instanceof z.ZodType ? second : second.schema;
    const combine = (left: z.ZodType, right: z.ZodType): z.ZodType =>
      left instanceof z.ZodObject && right instanceof z.ZodObject
        ? left.extend(right.shape)
        : right;
    const schema = combine(firstSchema, secondSchema);
    const firstValidation =
      first instanceof z.ZodType || first.validate !== false
        ? first instanceof z.ZodType
          ? first
          : (first[RequestValidationSchemaSymbol] ?? first.schema)
        : undefined;
    const secondValidation =
      second instanceof z.ZodType || second.validate !== false
        ? second instanceof z.ZodType
          ? second
          : (second[RequestValidationSchemaSymbol] ?? second.schema)
        : undefined;
    const validationSchema = firstValidation
      ? secondValidation
        ? combine(firstValidation, secondValidation)
        : firstValidation
      : secondValidation;

    merged[target] = {
      schema,
      validate: validationSchema !== undefined,
      ...(validationSchema && {
        [RequestValidationSchemaSymbol]: validationSchema,
      }),
    };
  }
  return merged;
};

/**
 * Merges two OpenAPI operation fragments into one.
 *
 * - `responses` merge per status code; conflict checks reject different schemas.
 * - Request object schemas merge per property within each target.
 * - Array keys (`tags`, `security`, `parameters`, `servers`, `callbacks`)
 *   concatenate and dedupe.
 * - Remaining scalar document keys: the second fragment wins.
 */
export function mergeOperations(
  first: HonoOpenApiOperation,
  second: HonoOpenApiOperation,
): HonoOpenApiOperation {
  const merged = mergeObjects(first, second) as unknown as HonoOpenApiOperation;
  merged.responses = mergeResponses(first.responses, second.responses);

  if (first.request || second.request) {
    merged.request =
      first.request && second.request
        ? mergeRequests(first.request, second.request)
        : (first.request ?? second.request);
  }

  for (const key of ARRAY_KEYS) {
    const firstValue = (first as unknown as Record<ArrayKey, unknown>)[key];
    const secondValue = (second as unknown as Record<ArrayKey, unknown>)[key];
    if (!Array.isArray(firstValue) && !Array.isArray(secondValue)) continue;
    (merged as unknown as Record<ArrayKey, unknown>)[key] = mergeArrays(
      firstValue,
      secondValue,
    );
  }

  return merged;
}
