import {
  evaluateCompletionReadiness,
  WorkflowTemplateQueryRepository,
  type WorkflowAggregateView,
  type WorkflowChecklistDdbRecord,
  type WorkflowEvidenceView,
  type WorkflowInstanceView,
  type WorkflowStatus,
  type WorkflowStepView,
} from '@api-hub/workflow-runtime-core';

import {
  applyDisplayAssigneeToWorkflowView,
  resolveAssigneeFromSteps,
  toStepTrackerDto,
  toWorkflowEvidenceHttpDto,
  toWorkflowInstanceHttpDto,
  type WorkflowAssigneeDisplayRef,
} from '../mappers/workflow-query-http.mapper';

function toEvaluatorStep(s: WorkflowStepView) {
  return {
    stepId: s.stepId,
    stepStatus: s.stepStatus,
    requirement: s.requirement,
    allowSkip: s.allowSkip,
    allowDefer: s.allowDefer,
    condition: s.condition,
  } as Parameters<typeof evaluateCompletionReadiness>[0]['steps'][number];
}

/**
 * HTTP projection helpers for workbench / completion-readiness (WR-08c).
 * Keeps evaluateCompletionReadiness out of controllers (mvrx/no-controller-business-logic).
 */
export class WorkflowQueryProjectionService {
  constructor(
    private readonly templates: WorkflowTemplateQueryRepository = new WorkflowTemplateQueryRepository(),
  ) {}

  buildCompletionReadiness(
    aggregate: WorkflowAggregateView,
    checklists: WorkflowChecklistDdbRecord[] = [],
  ) {
    return evaluateCompletionReadiness({
      workflowStatus: aggregate.workflow.workflowStatus as WorkflowStatus,
      steps: aggregate.steps.map(toEvaluatorStep),
      checklists,
    });
  }

  /**
   * Resolve assignee for PDP display without mutating persisted workflow records.
   * Precedence: persisted workflow → persisted step → template defaultAssignee
   * only when workflow.templateVersion still matches the live template version.
   */
  async resolveDisplayAssignee(
    aggregate: WorkflowAggregateView,
  ): Promise<WorkflowAssigneeDisplayRef | undefined> {
    const { workflow } = aggregate;
    if (workflow.assigneeType !== undefined && workflow.assigneeId !== undefined) {
      return { assigneeType: workflow.assigneeType, assigneeId: workflow.assigneeId };
    }

    const fromSteps = resolveAssigneeFromSteps(aggregate.steps);
    if (fromSteps) {
      return fromSteps;
    }

    return this.resolveMatchingTemplateDefaultAssignee(workflow);
  }

  /**
   * Template METADATA is mutable in-place on publish (same templateId, bumped version).
   * Historical defaultAssignee is not stored per version in audit/history, so only
   * use the current METADATA row when its version still equals workflow.templateVersion.
   */
  private async resolveMatchingTemplateDefaultAssignee(
    workflow: WorkflowInstanceView,
  ): Promise<WorkflowAssigneeDisplayRef | undefined> {
    const templateId = workflow.sourceTemplateId?.trim();
    const workflowTemplateVersion = workflow.templateVersion;
    if (!templateId || workflowTemplateVersion === undefined) {
      return undefined;
    }

    const orgMetadata = await this.templates.getTemplateMetadata({
      scope: 'organization',
      organizationId: workflow.organizationId,
      templateId,
    });
    if (orgMetadata?.version === workflowTemplateVersion) {
      return this.assigneeFromTemplateMetadata(orgMetadata);
    }

    const platformMetadata = await this.templates.getTemplateMetadata({
      scope: 'platform',
      templateId,
    });
    if (platformMetadata?.version === workflowTemplateVersion) {
      return this.assigneeFromTemplateMetadata(platformMetadata);
    }

    return undefined;
  }

  private assigneeFromTemplateMetadata(
    metadata: { defaultAssignee?: { assigneeType?: string; assigneeId?: string } },
  ): WorkflowAssigneeDisplayRef | undefined {
    if (!metadata.defaultAssignee?.assigneeType || !metadata.defaultAssignee.assigneeId) {
      return undefined;
    }
    return {
      assigneeType: metadata.defaultAssignee.assigneeType,
      assigneeId: metadata.defaultAssignee.assigneeId,
    };
  }

  async buildWorkbench(input: {
    aggregate: WorkflowAggregateView;
    checklists: WorkflowChecklistDdbRecord[];
    evidenceItems: WorkflowEvidenceView[];
  }) {
    const { aggregate, checklists, evidenceItems } = input;
    const readiness = this.buildCompletionReadiness(aggregate, checklists);
    const completed = aggregate.steps.filter((s) => s.stepStatus === 'completed')
      .length;
    const displayAssignee = await this.resolveDisplayAssignee(aggregate);
    const workflowForDto = displayAssignee
      ? applyDisplayAssigneeToWorkflowView(aggregate.workflow, displayAssignee)
      : aggregate.workflow;

    return {
      workflow: toWorkflowInstanceHttpDto(workflowForDto),
      banner: {
        workflowStatus: aggregate.workflow.workflowStatus,
        workflowType: aggregate.workflow.workflowType,
        dueAt: aggregate.workflow.dueAt,
      },
      stepsTracker: toStepTrackerDto(aggregate.steps, checklists, displayAssignee),
      blockers: readiness.blockingIssues,
      missingRequirements: readiness.missingRequirements,
      progress: {
        completed,
        totalApplicable: aggregate.steps.length,
      },
      evidence: evidenceItems.map(toWorkflowEvidenceHttpDto),
      ctas: {
        canComplete: readiness.ready,
        canResume:
          aggregate.workflow.workflowStatus === 'waiting' ||
          aggregate.workflow.workflowStatus === 'blocked',
      },
    };
  }
}
