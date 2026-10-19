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
    it('allows disjoint properties within the same target', () => {
      const first: HonoOpenApiOperation = {
        request: { header: z.object({ authorization: z.string() }) },
        responses: {},
      };
      const second: HonoOpenApiOperation = {
        request: { header: z.object({ 'x-request-id': z.string() }) },
        responses: {},
      };

      const conflicts = detectOpenApiRuntimeConflicts(first, second);
      expect(conflicts).toEqual([]);
    });

    it('adds a conflict when the same property has a different schema', () => {
      const conflicts = detectOpenApiRuntimeConflicts(
        {
          request: { header: z.object({ authorization: z.string() }) },
          responses: {},
        },
        {
          request: { header: z.object({ authorization: z.number() }) },
          responses: {},
        },
      );
      expect(conflicts).toContainEqual({
        kind: 'request',
        key: 'header.authorization',
      });
    });

    it('allows cosmetic metadata differences', () => {
      const first: HonoOpenApiOperation = {
        request: {
          header: z
            .object({
              authorization: z.string().meta({ description: 'auth' }),
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

    it('rejects different validation refinements on the same property', () => {
      const conflicts = detectOpenApiRuntimeConflicts(
        {
          request: { header: z.object({ id: z.string().min(1) }) },
          responses: {},
        },
        {
          request: { header: z.object({ id: z.string().max(10) }) },
          responses: {},
        },
      );
      expect(conflicts).toContainEqual({
        kind: 'request',
        key: 'header.id',
      });
    });
  });

  describe('response conflicts', () => {
    it('allows a response status redeclaration when schemas match', () => {
      const schema = z.object({ message: z.string() });
      const first: HonoOpenApiOperation = {
        responses: { 401: schema },
      };
      const second: HonoOpenApiOperation = {
        responses: { 401: z.object({ message: z.string() }) },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('rejects a response status redeclaration when schemas differ', () => {
      const first: HonoOpenApiOperation = {
        responses: { 401: z.object({ message: z.string() }) },
      };
      const second: HonoOpenApiOperation = {
        responses: { 401: z.object({ status: z.string() }) },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toContainEqual({
        kind: 'responses',
        key: '401',
      });
    });

    it('allows matching response schemas with different descriptions', () => {
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
            schema: z.object({ code: z.string(), message: z.string() }),
          },
        },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('rejects differing response schemas despite differing descriptions', () => {
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

    it('allows repeated references to the same response schema', () => {
      const first: HonoOpenApiOperation = {
        responses: { 401: { $ref: '#/components/responses/Unauthorized' } },
      };
      const second: HonoOpenApiOperation = {
        responses: { 401: { $ref: '#/components/responses/Unauthorized' } },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('allows a doc-only wildcard status when its schemas match', () => {
      const first: HonoOpenApiOperation = {
        responses: { '4XX': z.any(), default: z.object({ code: z.string() }) },
      };
      const second: HonoOpenApiOperation = {
        responses: { '4XX': z.any() },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toEqual([]);
    });

    it('rejects redeclared responses without a zod schema', () => {
      const first: HonoOpenApiOperation = {
        responses: { 204: { description: 'No content' } },
      };
      const second: HonoOpenApiOperation = {
        responses: { 204: z.never() },
      };

      expect(detectOpenApiRuntimeConflicts(first, second)).toContainEqual({
        kind: 'responses',
        key: '204',
      });
    });

    it('treats required-vs-optional properties as conflicting', () => {
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
      expect(conflicts).toContainEqual({
        kind: 'request',
        key: 'header.authorization',
      });
    });
  });
});
