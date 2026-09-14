/**
 * WR-07: DynamoDB Streams outbox relay → EventBridge.
 * Thin Lambda: filter Outbox INSERT → OutboxRelayService → PutEvents → markPublished/delete.
 */
import type { DynamoDBStreamEvent, DynamoDBStreamHandler } from 'aws-lambda';

import {
  OutboxRelayService,
  extractOutboxInsertCandidates,
} from '@api-hub/workflow-runtime-core';

import { getWorkflowTableName } from '../../config/env';

export const main: DynamoDBStreamHandler = async (
  event: DynamoDBStreamEvent,
) => {
  // Touch table env early so misconfig fails loudly.
  void getWorkflowTableName();

  const candidates = extractOutboxInsertCandidates(event.Records ?? []);
  if (candidates.length === 0) {
    return { batchItemFailures: [] };
  }

  const relay = new OutboxRelayService();
  const result = await relay.processCandidates(candidates);

  return {
    batchItemFailures: result.failedStreamEventIds.map(
      (itemIdentifier: string) => ({
        itemIdentifier,
      }),
    ),
  };
};

export default main;
