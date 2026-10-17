/**
 * Symbol attached to `openApi()`-created middleware holding the operation it
 * was created with (runtime metadata for `createOpenApiDocument`).
 */
export const OpenApiSymbol = Symbol();

/**
 * Type-level and runtime marker for fragment-shaped middleware: middleware
 * created by `openApi()`/`createOpenApiFragment()` carry their operation
 * (request and response shapes) so fragments can be composed/nested, merged in
 * the generated document, and statically checked for schema conflicts.
 */
export const FragmentShapeSymbol: unique symbol = Symbol();

/** Runtime middleware inside a fragment, without its already-merged validators. */
export const FragmentMiddlewareSymbol: unique symbol = Symbol();

/** Runtime-only schema when docs merge also includes validate:false fields. */
export const RequestValidationSchemaSymbol: unique symbol = Symbol();
