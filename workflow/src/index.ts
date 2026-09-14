/**
 * @api-hub/workflow-service
 *
 * Thin app entry for Nx build. Lambda handlers are wired via serverless.yml.
 * Domain logic lives in @api-hub/workflow-runtime-core.
 */
export * from './config';
export * from './handlers';
export * from './controllers';
export * from './validators';

export { workflowRuntimeCore } from '@api-hub/workflow-runtime-core';
