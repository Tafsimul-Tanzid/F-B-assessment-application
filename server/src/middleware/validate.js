import { ValidationError } from '../errors/index.js';

/**
 * Validates request parts against zod schemas.
 *
 * Parsed output is written to `req.validated`, and controllers read from there
 * rather than from `req.body` / `req.query` / `req.params` directly. That way
 * a controller cannot accidentally use an unvalidated, uncoerced value — query
 * strings in particular arrive as strings and need coercion before use.
 *
 * @param {{ body?: import('zod').ZodTypeAny,
 *           params?: import('zod').ZodTypeAny,
 *           query?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const validated = {};
    const issues = [];

    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) continue;

      const result = schema.safeParse(req[part]);
      if (result.success) {
        validated[part] = result.data;
      } else {
        issues.push(
          ...result.error.issues.map((issue) => ({
            in: part,
            field: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
    }

    if (issues.length) return next(new ValidationError(issues));

    req.validated = validated;
    return next();
  };
}

export default validate;
