import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const eventBridge = new EventBridgeClient({});

const HEALTH_ITEM = { pk: 'HEALTH', sk: 'PING' };

export async function main() {
  const tableName = process.env.WORKFLOW_TABLE;
  const busName = process.env.WORKFLOW_EVENT_BUS_NAME;
  const source = process.env.WORKFLOW_EVENT_SOURCE || 'workflow-service';
  const updatedAt = new Date().toISOString();

  if (tableName) {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...HEALTH_ITEM, updatedAt },
      }),
    );
    await ddb.send(
      new GetCommand({
        TableName: tableName,
        Key: HEALTH_ITEM,
      }),
    );
  }

  if (busName) {
    const putEvents = await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: busName,
            Source: source,
            DetailType: 'HealthPing',
            Detail: JSON.stringify({ message: 'Scope service is working', updatedAt }),
          },
        ],
      }),
    );
    if (putEvents.FailedEntryCount) {
      throw new Error('EventBridge PutEvents failed');
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'healthy',
      message: 'Scope service is working',
    }),
  };
}
