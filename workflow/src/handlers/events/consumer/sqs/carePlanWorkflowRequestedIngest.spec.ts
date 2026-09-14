import type { SQSEvent } from 'aws-lambda';

const processBatch = jest.fn();

jest.mock('../../../../consumers/care-plan-workflow-requested.consumer', () => ({
  getCarePlanWorkflowRequestedConsumer: () => ({
    handleSqsEvent: processBatch,
  }),
}));

import { main } from './carePlanWorkflowRequestedIngest';

describe('carePlanWorkflowRequestedIngest handler', () => {
  beforeEach(() => {
    processBatch.mockReset();
  });

  it('delegates to CarePlanWorkflowRequestedConsumer and returns batch failures', async () => {
    processBatch.mockResolvedValue({
      batchItemFailures: [{ itemIdentifier: 'm1' }],
    });

    const event = { Records: [] } as SQSEvent;
    const result = await main(event, {} as never, () => undefined);

    expect(processBatch).toHaveBeenCalledWith(event);
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'm1' }],
    });
  });
});
