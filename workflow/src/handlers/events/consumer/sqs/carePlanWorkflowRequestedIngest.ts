/**
 * WR-09: SQS ingest entry for CarePlanWorkflowRequested.v1.
 * Thin Lambda — orchestration lives in CarePlanWorkflowRequestedConsumer.
 */
import type { SQSBatchResponse, SQSEvent, SQSHandler } from 'aws-lambda';

import { getCarePlanWorkflowRequestedConsumer } from '../../../../consumers/care-plan-workflow-requested.consumer';

export const main: SQSHandler = async (
  event: SQSEvent,
): Promise<SQSBatchResponse> => {
  return getCarePlanWorkflowRequestedConsumer().handleSqsEvent(event);
};

export default main;
