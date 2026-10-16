import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { detectOpenApiRuntimeConflicts } from './conflicts.ts';
import type { HonoOpenApiOperation } from './types.ts';

describe('detectOpenApiRuntimeConflicts', () => {
  describe('no conflicts', () => {
    it('allows disjoint targets and statuses', () => {
      const first: HonoOpenApiOperation = {
        request: { header: z.object({ authorization: z.string() }) },
        responses: { 401: z.object({ code: z.string() }) },
      };
      const second: HonoOpenApiOperation = {
        request: { json: z.object({ name: z.string() }) },
        responses: { 200: z.object({ name: z.string() }) },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });
  });

  describe('request conflicts', () => {
    it('adds a conflict when the same target is declared with two different payloads', () => {
      const first: HonoOpenApiOperation = {
        request: { header: z.object({ authorization: z.string() }) },
        responses: {},
      };
      const second: HonoOpenApiOperation = {
        request: { header: z.object({ authorization: z.number() }) },
        responses: {},
      };

      const conflicts = detectOpenApiRuntimeConflicts(first, second);
      expect(conflicts).toContainEqual({ kind: 'request', key: 'header' });
    });

    it('does not fight over cosmetic differences like descriptions or refinements', () => {
      const first: HonoOpenApiOperation = {
        request: {
          header: z
            .object({
              authorization: z.string().min(1).meta({ description: 'auth' }),
            })
            .meta({ description: 'first' }),
        },
        responses: {},
      };
      const second: HonoOpenApiOperation = {
        request: {
          header: z.object({
            authorization: z.string().meta({ description: 'other' }),
          }),
        },
        responses: {},
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });
  });

  describe('response conflicts', () => {
    it('adds a conflict when the same status is declared with two different schemas', () => {
      const first: HonoOpenApiOperation = {
        responses: { 401: z.object({ message: z.string() }) },
      };
      const second: HonoOpenApiOperation = {
        responses: { 401: z.object({ status: z.string() }) },
      };

      const conflicts = detectOpenApiRuntimeConflicts(first, second);
      expect(conflicts).toContainEqual({ kind: 'responses', key: '401' });
    });

    it('compares full response objects, skipping differing descriptions', () => {
      const first: HonoOpenApiOperation = {
        responses: {
          401: {
            description: 'Missing bearer token',
            schema: z.object({ code: z.string(), message: z.string() }),
          },
        },
      };
      const second: HonoOpenApiOperation = {
        responses: {
          401: {
            description: 'Unauthorized',
            schema: z.object({ code: z.literal('NOPE'), message: z.string() }),
          },
        },
      };

      const conflicts = detectOpenApiRuntimeConflicts(first, second);
      expect(conflicts).toContainEqual({ kind: 'responses', key: '401' });
    });

    it('treats doc-only wildcard aliases (z.any) as non-comparable', () => {
      const first: HonoOpenApiOperation = {
        responses: { '4XX': z.any(), default: z.object({ code: z.string() }) },
      };
      const second: HonoOpenApiOperation = {
        responses: { '4XX': z.object({ code: z.string() }) },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('skips responses without a zod schema', () => {
      const first: HonoOpenApiOperation = {
        responses: { 204: { description: 'No content' } },
      };
      const second: HonoOpenApiOperation = {
        responses: { 204: z.never() },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('treats required-vs-optional members as conflicting', () => {
      const first: HonoOpenApiOperation = {
        request: {
          header: z.object({ authorization: z.string() }),
        },
        responses: {},
      };
      const second: HonoOpenApiOperation = {
        request: {
          header: z.object({
            authorization: z.string().optional(),
          }),
        },
        responses: {},
      };

      const conflicts = detectOpenApiRuntimeConflicts(first, second);
      expect(conflicts).toContainEqual({ kind: 'request', key: 'header' });
    });
  });
});
