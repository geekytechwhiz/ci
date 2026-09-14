import { withApiHandler } from '@api-hub/middleware';
import { LambdaRequest } from '@api-hub/utils';
import { workflowRuntimeCore } from '@api-hub/workflow-runtime-core';

import { getWorkflowRuntimeAppEnv } from '../../config';

const handler = async (req: LambdaRequest) => {
  const libStatus = workflowRuntimeCore();
  const env = getWorkflowRuntimeAppEnv();

  req.context.logger.info({
    message: 'Workflow runtime core status',
    status: libStatus,
  });

  return {
    status: 'healthy',
    service: 'workflow-service',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    requestId: req.context.awsRequestId,
    correlationId: req.context.correlationId,
    region: env.AWS_REGION,
    stage: env.NODE_ENV,
  };
};

export const main = withApiHandler(
  {
    operation: 'workflow-service.health',
    useLegacyResponseFormat: true,
  },
  handler,
);

export default main;
