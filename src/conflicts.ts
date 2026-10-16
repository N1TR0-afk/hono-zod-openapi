import * as z from 'zod';
import { createSchema } from 'zod-openapi';
import type {
  HonoOpenApiOperation,
  HonoOpenApiRequestSchemas,
  HonoOpenApiResponses,
} from './types.ts';

/**
 * Runtime counterpart of the static `OpenApiShapeConflicts` check.
 *
 * The static check can only compare declarations that pass through a single
 * `openApi()` call. Middleware composed as separate chain entries are accepted
 * by Hono's variadic registration independently, so a conflicting schema pair
 * can only be detected when the document is built. This module performs the
 * same comparison on the collected shapes of a route chain and reports the
 * conflicting keys so `createOpenApiDocument` can fail fast instead of
 * letting the last declaration silently win.
 */

export interface OpenApiRuntimeConflict {
  kind: 'request' | 'responses';
  key: string;
}

/**
 * Keys that only refine the schema without changing its validated output
 * (the static check compares `z.output` equality, so excluding them mirrors
 * "different description, same schema" compositions being allowed).
 */
const REFERENCE_ONLY_KEYS = new Set([
  'description',
  'example',
  'examples',
  'title',
  'default',
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'additionalProperties',
]);

export interface OpenApiRuntimeConflict {
  kind: 'request' | 'responses';
  key: string;
}

/**
 * Schemas whose validated output is not a concrete shape (e.g. `z.any()`) are
 * not comparable — same as the static check, they never conflict.
 */
const isConcreteSchema = (schema: z.ZodType): boolean =>
  !(
    schema instanceof z.ZodAny ||
    schema instanceof z.ZodNever ||
    schema instanceof z.ZodUnknown
  );

const schemaOfRequestTarget = (value: unknown): z.ZodType | null => {
  if (value instanceof z.ZodType) {
    return value;
  }

  if (
    value &&
    typeof value === 'object' &&
    'schema' in value &&
    value.schema instanceof z.ZodType
  ) {
    // doc-only targets (`validate: false`) are skipped, like the static check
    if ('validate' in value && value.validate === false) {
      return null;
    }

    return value.schema;
  }

  return null;
};

const schemaOfResponse = (value: unknown): z.ZodType | null => {
  if (value instanceof z.ZodType) {
    return value;
  }

  if (!value || typeof value !== 'object' || '$ref' in value) {
    return null;
  }

  if ('schema' in value && value.schema instanceof z.ZodType) {
    return value.schema;
  }

  if (
    'content' in value &&
    value.content &&
    typeof value.content === 'object'
  ) {
    for (const mediaDefinition of Object.values(
      value.content as Record<string, unknown>,
    )) {
      if (
        mediaDefinition &&
        typeof mediaDefinition === 'object' &&
        'schema' in mediaDefinition &&
        mediaDefinition.schema instanceof z.ZodType
      ) {
        return mediaDefinition.schema;
      }
    }
  }

  return null;
};

/**
 * Canonicalizes a generated JSON schema so equal validated outputs produce
 * equal results. Property and member order, metadata-only keys and validation
 * refinements are normalized away.
 */
const canonicalize = (node: unknown, key?: string): unknown => {
  if (Array.isArray(node)) {
    const items = node.map((item) => canonicalize(item));
    // member order doesn't change the validated output for these keys
    if (key === 'enum') {
      return (
        items
          .map((item) => JSON.stringify(item))
          // oxlint-disable-next-line unicorn/no-array-sort -- freshly-created array, safe to sort in place
          .sort()
          .map((serialized) => JSON.parse(serialized) as unknown)
      );
    }

    if (key === 'required') {
      // oxlint-disable-next-line unicorn/no-array-sort -- freshly-created array, safe to sort in place
      return (items as string[]).sort();
    }

    return items;
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  const result: Record<string, unknown> = {};
  for (const memberKey of Object.keys(
    node as Record<string, unknown>,
    // oxlint-disable-next-line unicorn/no-array-sort -- freshly-created array, safe to sort in place
  ).sort()) {
    if (memberKey.startsWith('x-')) continue;
    if (REFERENCE_ONLY_KEYS.has(memberKey)) continue;
    if (memberKey === '$ref' || memberKey === '$schema' || memberKey === 'id') {
      // generated schemas are inlined (no registry), so $ref reuse of a
      // different registry would be a false conflict; the shared `$ref`s
      // cannot be resolved here — unresolvable, therefore non-conflicting
      return {};
    }

    const value = canonicalize(
      (node as Record<string, unknown>)[memberKey],
      memberKey,
    );
    if (value !== undefined) {
      result[memberKey] = value;
    }
  }

  return result;
};

const schemaShape = (schema: z.ZodType): unknown =>
  canonicalize(createSchema(schema, { io: 'output' }).schema);

const outputsEqual = (first: z.ZodType, second: z.ZodType): boolean =>
  JSON.stringify(schemaShape(first)) === JSON.stringify(schemaShape(second));

const conflictingRequestTargets = (
  first: HonoOpenApiRequestSchemas,
  second: HonoOpenApiRequestSchemas,
): string[] => {
  const conflicts: string[] = [];
  for (const target of Object.keys(first) as Array<
    keyof HonoOpenApiRequestSchemas & string
  >) {
    if (!(target in second)) continue;

    const firstSchema = schemaOfRequestTarget(first[target]);
    const secondSchema = schemaOfRequestTarget(second[target]);

    if (!firstSchema || !secondSchema) continue;
    if (!isConcreteSchema(firstSchema) || !isConcreteSchema(secondSchema)) {
      continue;
    }

    if (!outputsEqual(firstSchema, secondSchema)) {
      conflicts.push(target);
    }
  }

  return conflicts;
};

const conflictingResponseKeys = (
  first: HonoOpenApiResponses,
  second: HonoOpenApiResponses,
): string[] => {
  const conflicts: string[] = [];
  for (const status of Object.keys(first) as Array<
    keyof HonoOpenApiResponses & string
  >) {
    if (!(status in second)) continue;

    const firstSchema = schemaOfResponse(first[status]);
    const secondSchema = schemaOfResponse(second[status]);

    if (!firstSchema || !secondSchema) continue;
    if (!isConcreteSchema(firstSchema) || !isConcreteSchema(secondSchema)) {
      continue;
    }

    if (!outputsEqual(firstSchema, secondSchema)) {
      conflicts.push(status);
    }
  }

  return conflicts;
};

/**
 * Compares the declarations of two `openApi` shapes attached to the same
 * route chain. Returns every target/status key that both declare with
 * schemas of different validated outputs (an empty array means compatible).
 */
export const detectOpenApiRuntimeConflicts = (
  first: HonoOpenApiOperation,
  second: HonoOpenApiOperation,
): OpenApiRuntimeConflict[] => {
  const conflicts: OpenApiRuntimeConflict[] = [];

  if (first.request && second.request) {
    for (const target of conflictingRequestTargets(
      first.request,
      second.request,
    )) {
      conflicts.push({ kind: 'request', key: target });
    }
  }

  if (first.responses && second.responses) {
    for (const status of conflictingResponseKeys(
      first.responses,
      second.responses,
    )) {
      conflicts.push({ kind: 'responses', key: status });
    }
  }

  return conflicts;
};

export const describeRuntimeConflict = (
  conflict: OpenApiRuntimeConflict,
): string =>
  conflict.kind === 'request'
    ? `request target '${conflict.key}'`
    : `response '${conflict.key}'`;
