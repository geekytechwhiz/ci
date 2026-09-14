import { BaseError } from '@api-hub/utils';
import { WorkflowQueryRepository } from '@api-hub/workflow-runtime-core';

import {
  toPaginatedHttpDto,
  toQueueRowHttpDto,
  toWorkflowAuditHttpDto,
  toWorkflowEvidenceHttpDto,
  applyDisplayAssigneeToWorkflowView,
  toWorkflowInstanceHttpDto,
  toWorkflowNoteHttpDto,
  toWorkflowStepHttpDto,
} from '../mappers/workflow-query-http.mapper';
import { WorkflowQueryProjectionService } from '../services/workflow-query-projection.service';
import { okData } from '../utils/definition-http-response';
import type {
  ValidatedDashboardQueueRequest,
  ValidatedGetWorkflowRequest,
  ValidatedListEvidenceRequest,
  ValidatedListHistoryRequest,
  ValidatedListNotesRequest,
  ValidatedListWorkflowsRequest,
  ValidatedReadinessRequest,
  ValidatedWorkbenchRequest,
} from '../validators/workflow-query.validators';

function notFound(workflowId: string): never {
  throw new BaseError(
    `Workflow not found: ${workflowId}`,
    404,
    'NOT_FOUND',
    [{ message: `Workflow not found: ${workflowId}` }],
    { retryable: false },
  );
}

let queryRepo: WorkflowQueryRepository | undefined;
let projections: WorkflowQueryProjectionService | undefined;

function getQueryRepo(): WorkflowQueryRepository {
  if (!queryRepo) queryRepo = new WorkflowQueryRepository();
  return queryRepo;
}

function getProjections(): WorkflowQueryProjectionService {
  if (!projections) projections = new WorkflowQueryProjectionService();
  return projections;
}

let ctrl: WorkflowQueryHttpController | undefined;

export function getWorkflowQueryHttpController(
  deps?: {
    query?: WorkflowQueryRepository;
    projections?: WorkflowQueryProjectionService;
  },
): WorkflowQueryHttpController {
  if (!ctrl) {
    ctrl = new WorkflowQueryHttpController(
      deps?.query ?? getQueryRepo(),
      deps?.projections ?? getProjections(),
    );
  }
  return ctrl;
}

export function resetWorkflowQueryHttpControllerForTests(): void {
  ctrl = undefined;
  queryRepo = undefined;
  projections = undefined;
}

export class WorkflowQueryHttpController {
  constructor(
    private readonly query: WorkflowQueryRepository,
    private readonly projectionsSvc: WorkflowQueryProjectionService = new WorkflowQueryProjectionService(),
  ) {}

  async handleGetWorkflow(req: ValidatedGetWorkflowRequest) {
    const v = req.validatedGetWorkflow;
    const { include } = v;

    if (include.steps || include.notes || include.evidence) {
      const aggregate = await this.query.getWorkflowWithSteps({
        organizationId: v.organizationId,
        workflowId: v.workflowId,
      });
      if (!aggregate) notFound(v.workflowId);

      const workflow = toWorkflowInstanceHttpDto(aggregate.workflow);
      const response: Record<string, unknown> = { ...workflow };

      if (include.steps) {
        response.steps = aggregate.steps.map(toWorkflowStepHttpDto);
      }
      if (include.notes) {
        const notes = await this.query.listNotes({
          organizationId: v.organizationId,
          workflowId: v.workflowId,
        });
        response.notes = notes.items.map(toWorkflowNoteHttpDto);
      }
      if (include.evidence) {
        const evidence = await this.query.listEvidence({
          organizationId: v.organizationId,
          workflowId: v.workflowId,
        });
        response.evidence = evidence.items.map(toWorkflowEvidenceHttpDto);
      }
      return okData(req, response);
    }

    const workflow = await this.query.getWorkflowById({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
    });
    if (!workflow) notFound(v.workflowId);
    return okData(req, toWorkflowInstanceHttpDto(workflow));
  }

  async handleListHistory(req: ValidatedListHistoryRequest) {
    const v = req.validatedListHistory;
    const page = await this.query.listHistory({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      limit: v.limit,
      cursor: v.cursor,
    });
    return okData(
      req,
      toPaginatedHttpDto({
        items: page.items.map(toWorkflowAuditHttpDto),
        nextCursor: page.nextCursor,
      }),
    );
  }

  async handleListNotes(req: ValidatedListNotesRequest) {
    const v = req.validatedListNotes;
    const page = await this.query.listNotes({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      limit: v.limit,
      cursor: v.cursor,
    });
    return okData(
      req,
      toPaginatedHttpDto({
        items: page.items.map(toWorkflowNoteHttpDto),
        nextCursor: page.nextCursor,
      }),
    );
  }

  async handleListEvidence(req: ValidatedListEvidenceRequest) {
    const v = req.validatedListEvidence;
    const page = await this.query.listEvidence({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      limit: v.limit,
      cursor: v.cursor,
    });
    return okData(
      req,
      toPaginatedHttpDto({
        items: page.items.map(toWorkflowEvidenceHttpDto),
        nextCursor: page.nextCursor,
      }),
    );
  }

  async handleListWorkflows(req: ValidatedListWorkflowsRequest) {
    const v = req.validatedListWorkflows;
    const page = await this.query.listWorkflows({
      organizationId: v.organizationId,
      patientId: v.patientId,
      carePlanId: v.carePlanId,
      workflowType: v.workflowType,
      workflowStatus: v.workflowStatus,
      assigneeType: v.assigneeType,
      assigneeId: v.assigneeId,
      dueBefore: v.dueBefore,
      dueAfter: v.dueAfter,
      overdue: v.overdue,
      limit: v.limit,
      cursor: v.cursor,
    });

    const items = v.carePlanId?.trim()
      ? await this.enrichCarePlanListAssignee(v.organizationId, page.items)
      : page.items;

    return okData(
      req,
      toPaginatedHttpDto({
        items: items.map(toWorkflowInstanceHttpDto),
        nextCursor: page.nextCursor,
      }),
    );
  }

  /**
   * PDP Care Plan → Workflows list: expose assignee on existing instances that
   * were created before template-default seeding, without mutating DynamoDB.
   */
  private async enrichCarePlanListAssignee(
    organizationId: string,
    items: Awaited<ReturnType<WorkflowQueryRepository['listWorkflows']>>['items'],
  ) {
    return Promise.all(
      items.map(async (item) => {
        if (item.assigneeType !== undefined) {
          return item;
        }
        const aggregate = await this.query.getWorkflowWithSteps({
          organizationId,
          workflowId: item.workflowId,
        });
        if (!aggregate) {
          return item;
        }
        const displayAssignee =
          await this.projectionsSvc.resolveDisplayAssignee(aggregate);
        if (!displayAssignee) {
          return item;
        }
        return applyDisplayAssigneeToWorkflowView(item, displayAssignee);
      }),
    );
  }

  async handleDashboardQueue(req: ValidatedDashboardQueueRequest) {
    const v = req.validatedDashboardQueue;
    const page = await this.query.listDashboardQueue({
      organizationId: v.organizationId,
      queue: v.queue,
      assigneeUserId: v.assigneeUserId,
      limit: v.limit,
      cursor: v.cursor,
    });
    return okData(
      req,
      toPaginatedHttpDto({
        items: page.items.map(toQueueRowHttpDto),
        nextCursor: page.nextCursor,
      }),
    );
  }

  async handleWorkbench(req: ValidatedWorkbenchRequest) {
    const v = req.validatedWorkbench;
    const aggregate = await this.query.getWorkflowWithSteps({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
    });
    if (!aggregate) notFound(v.workflowId);

    const [evidence, checklists] = await Promise.all([
      this.query.listEvidence({
        organizationId: v.organizationId,
        workflowId: v.workflowId,
      }),
      this.query.listChecklists({
        organizationId: v.organizationId,
        workflowId: v.workflowId,
      }),
    ]);

    return okData(
      req,
      await this.projectionsSvc.buildWorkbench({
        aggregate,
        checklists,
        evidenceItems: evidence.items,
      }),
    );
  }

  async handleCompletionReadiness(req: ValidatedReadinessRequest) {
    const v = req.validatedReadiness;
    const aggregate = await this.query.getWorkflowWithSteps({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
    });
    if (!aggregate) notFound(v.workflowId);

    const checklists = await this.query.listChecklists({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
    });
    const readiness = this.projectionsSvc.buildCompletionReadiness(
      aggregate,
      checklists,
    );
    return okData(req, {
      ready: readiness.ready,
      missingRequirements: readiness.missingRequirements,
      blockingIssues: readiness.blockingIssues,
      completionSummary: readiness.completionSummary,
    });
  }
}
