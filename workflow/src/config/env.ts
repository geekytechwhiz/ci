import { z } from 'zod';

/** Central env boundary for workflow-service app handlers. */
 

const appEnvSchema = z.object({
  AWS_REGION: z.string().optional(),
  NODE_ENV: z.string().optional(),
  STAGE: z.string().optional(),
  SERVICE_NAME: z.string().optional(),
  LOG_LEVEL: z.string().optional(),
  WORKFLOW_TABLE: z.string().optional(),
  WORKFLOW_EVENT_BUS_NAME: z.string().optional(),
  WORKFLOW_EVENT_SOURCE: z.string().optional(),
  WORKFLOW_OUTBOX_RELAY_BATCH_SIZE: z.string().optional(),
  WORKFLOW_OUTBOX_POST_PUBLISH_MODE: z.string().optional(),
  WORKFLOW_EVENTS_QUEUE_URL: z.string().optional(),
  EVENT_DLQ_QUEUE_URL: z.string().optional(),
});

export type WorkflowRuntimeAppEnv = z.infer<typeof appEnvSchema>;

let cached: WorkflowRuntimeAppEnv | undefined;

export function getWorkflowRuntimeAppEnv(): WorkflowRuntimeAppEnv {
  if (!cached) {
    cached = appEnvSchema.parse({
      AWS_REGION: process.env.AWS_REGION,
      NODE_ENV: process.env.NODE_ENV,
      STAGE: process.env.STAGE,
      SERVICE_NAME: process.env.SERVICE_NAME,
      LOG_LEVEL: process.env.LOG_LEVEL,
      WORKFLOW_TABLE: process.env.WORKFLOW_TABLE,
      WORKFLOW_EVENT_BUS_NAME: process.env.WORKFLOW_EVENT_BUS_NAME,
      WORKFLOW_EVENT_SOURCE: process.env.WORKFLOW_EVENT_SOURCE,
      WORKFLOW_OUTBOX_RELAY_BATCH_SIZE: process.env.WORKFLOW_OUTBOX_RELAY_BATCH_SIZE,
      WORKFLOW_OUTBOX_POST_PUBLISH_MODE: process.env.WORKFLOW_OUTBOX_POST_PUBLISH_MODE,
      WORKFLOW_EVENTS_QUEUE_URL: process.env.WORKFLOW_EVENTS_QUEUE_URL,
      EVENT_DLQ_QUEUE_URL: process.env.EVENT_DLQ_QUEUE_URL,
    });
  }
  return cached;
}

export function getWorkflowTableName(): string {
  return getWorkflowRuntimeAppEnv().WORKFLOW_TABLE?.trim() || 'workflow-service-dev';
}

export function getWorkflowEventBusName(): string {
  return (
    getWorkflowRuntimeAppEnv().WORKFLOW_EVENT_BUS_NAME?.trim() ||
    'workflow-service-bus-dev'
  );
}
