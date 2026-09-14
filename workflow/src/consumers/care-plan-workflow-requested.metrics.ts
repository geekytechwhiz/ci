import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { getConfig } from '@api-hub/observability';

export type CarePlanWorkflowRequestedMetricName =
  | 'WorkflowCreated'
  | 'DuplicateEvent'
  | 'DuplicateWorkflow'
  | 'ValidationFailure'
  | 'Retry'
  | 'DLQ';

  /**
   * @description CloudWatch counters for WR-09 CarePlanWorkflowRequested consumer.
   * @see https://github.com/awslabs/aws-lambda-powertools-typescript/blob/main/packages/metrics/src/metrics.ts#L314
   */ 

export type CarePlanWorkflowRequestedMetrics = {
  increment(name: CarePlanWorkflowRequestedMetricName): void;
};

function createMetricsInstance(): Metrics {
  const cfg = getConfig();
  return new Metrics({
    namespace: cfg.metricsNamespace,
    serviceName: cfg.serviceName,
  });
}

/** CloudWatch counters for WR-09 CarePlanWorkflowRequested consumer. */
export function createCarePlanWorkflowRequestedMetrics(): CarePlanWorkflowRequestedMetrics {
  return {
    increment(name) {
      try {
        const m = createMetricsInstance();
        m.addDimension('eventType', 'CarePlanWorkflowRequested');
        m.addMetric(name, MetricUnit.Count, 1);
        m.publishStoredMetrics();
      } catch {
        // Never fail the consumer on metrics publish.
      }
    },
  };
}

export function createNoopCarePlanWorkflowRequestedMetrics(): CarePlanWorkflowRequestedMetrics {
  return { increment: () => undefined };
}
