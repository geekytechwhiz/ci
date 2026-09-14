import { BaseError, type LambdaRequest } from '@api-hub/utils';
import type { ZodError, ZodTypeAny } from 'zod';

/**
 * User-facing VALIDATION_ERROR description for Workflow Template HTTP body
 * failures. Structured field errors remain on {@link BaseError.details}.
 */
export const WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION =
  'Please correct the validation errors and try again.';

export function workflowTemplateZodErrorToBaseError(error: ZodError): BaseError {
  return new BaseError(
    WORKFLOW_TEMPLATE_VALIDATION_DESCRIPTION,
    400,
    'VALIDATION_ERROR',
    error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    })),
    { retryable: false },
  );
}

export function parseWorkflowTemplateHttpBody<T>(
  schema: ZodTypeAny,
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw workflowTemplateZodErrorToBaseError(parsed.error);
  }
  return parsed.data as T;
}

/**
 * Runs Workflow Template body Zod validation before the route validator so
 * ZodError never reaches shared toBaseError, which prefixes field paths onto
 * message.description.
 */
export function withWorkflowTemplateBodyValidation(
  bodySchema: ZodTypeAny | undefined,
  validator: (req: LambdaRequest) => void | Promise<void>,
): (req: LambdaRequest) => Promise<void> {
  return async (req) => {
    if (bodySchema !== undefined) {
      req.body = parseWorkflowTemplateHttpBody(bodySchema, req.body);
    }
    await validator(req);
  };
}
