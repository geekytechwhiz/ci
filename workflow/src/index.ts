/**
 * @api-hub/workflow-service
 *
 * Thin app entry for Nx build. Lambda handlers are wired via serverless.yml.
 */
export { main as httpHandler } from './handlers/http';
export { main as eventsHandler } from './handlers/events';
