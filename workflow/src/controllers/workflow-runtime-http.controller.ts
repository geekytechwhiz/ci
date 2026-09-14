import type { AssigneeType } from '@api-hub/workflow-runtime-core';
import { WorkflowEngineService } from '@api-hub/workflow-runtime-core';

import {
  toWorkflowChecklistHttpDto,
  toWorkflowInstanceHttpDto,
  toWorkflowStepHttpDto,
} from '../mappers/workflow-runtime-http.mapper';
import {
  createdWithEtag,
  okData,
  okWithEtag,
} from '../utils/definition-http-response';
import type {
  ValidatedAddStepChecklistRequest,
  ValidatedAddWorkflowStepRequest,
  ValidatedAssignChecklistRequest,
  ValidatedAssignStepRequest,
  ValidatedAssignWorkflowRequest,
  ValidatedBlockWorkflowRequest,
  ValidatedCancelWorkflowRequest,
  ValidatedChecklistActionRequest,
  ValidatedCompleteWorkflowRequest,
  ValidatedCreateWorkflowRequest,
  ValidatedGetChecklistRequest,
  ValidatedListStepChecklistsRequest,
  ValidatedListWorkflowChecklistsRequest,
  ValidatedRemoveStepChecklistRequest,
  ValidatedRemoveWorkflowStepRequest,
  ValidatedResumeWorkflowRequest,
  ValidatedStartWorkflowRequest,
  ValidatedStepActionRequest,
  ValidatedWaitWorkflowRequest,
} from '../validators/workflow-runtime.validators';

let engine: WorkflowEngineService | undefined;
function getEngine(): WorkflowEngineService {
  if (!engine) engine = new WorkflowEngineService();
  return engine;
}

let ctrl: WorkflowRuntimeHttpController | undefined;

export function getWorkflowRuntimeHttpController(
  deps?: { engine?: WorkflowEngineService },
): WorkflowRuntimeHttpController {
  if (!ctrl) {
    ctrl = new WorkflowRuntimeHttpController(deps?.engine ?? getEngine());
  }
  return ctrl;
}

export function resetWorkflowRuntimeHttpControllerForTests(): void {
  ctrl = undefined;
  engine = undefined;
}

export class WorkflowRuntimeHttpController {
  constructor(private readonly engine: WorkflowEngineService) {}

  async handleCreate(req: ValidatedCreateWorkflowRequest) {
    const v = req.validatedCreateWorkflow;
    const contextKey = v.body.contextKey ?? 'default';
    const autoStart = v.body.autoStart !== false;
    const carePlanTemplateId = v.body.carePlanTemplateId.trim();
    const workflowStage = v.body.workflowStage?.trim() || undefined;

    const idempotencyPayload = {
      workflowType: v.body.workflowType,
      patientId: v.body.patientId,
      carePlanId: v.body.carePlanId,
      contextKey,
      carePlanTemplateId,
      workflowStage: workflowStage ?? null,
      assignee: v.body.assignee ?? null,
      dueAt: v.body.dueAt ?? null,
      autoStart,
    };

    const result = await this.engine.create({
      organizationId: v.organizationId,
      workflowType: v.body.workflowType,
      patientId: v.body.patientId,
      carePlanId: v.body.carePlanId,
      contextKey: v.body.contextKey,
      carePlanTemplateId,
      workflowStage,
      assignee: v.body.assignee,
      dueAt: v.body.dueAt,
      autoStart: v.body.autoStart,
      correlationId: v.body.correlationId?.trim() || v.correlationId,
      createdBy: v.userId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      idempotencyPayload,
    });

    const workflow = toWorkflowInstanceHttpDto(result.workflow);
    return createdWithEtag(req, {
      ...workflow,
      replayed: result.replayed,
    });
  }

  async handleStart(req: ValidatedStartWorkflowRequest) {
    const v = req.validatedStartWorkflow;
    const result = await this.engine.start({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
    });
    return this.workflowOk(req, result);
  }

  async handleAssign(req: ValidatedAssignWorkflowRequest) {
    const v = req.validatedAssignWorkflow;
    const result = await this.engine.assign({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      assigneeType: v.assigneeType as AssigneeType,
      assigneeId: v.assigneeId,
      reason: v.reason,
    });
    return this.workflowOk(req, result);
  }

  async handleWait(req: ValidatedWaitWorkflowRequest) {
    const v = req.validatedWaitWorkflow;
    const result = await this.engine.wait({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      reason: v.reason,
    });
    return this.workflowOk(req, result);
  }

  async handleBlock(req: ValidatedBlockWorkflowRequest) {
    const v = req.validatedBlockWorkflow;
    const result = await this.engine.block({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      reason: v.reason,
    });
    return this.workflowOk(req, result);
  }

  async handleResume(req: ValidatedResumeWorkflowRequest) {
    const v = req.validatedResumeWorkflow;
    const result = await this.engine.resume({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
    });
    return this.workflowOk(req, result);
  }

  async handleComplete(req: ValidatedCompleteWorkflowRequest) {
    const v = req.validatedCompleteWorkflow;
    const result = await this.engine.complete({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      outcome: v.outcome,
      finalNote: v.finalNote,
    });
    const workflow = toWorkflowInstanceHttpDto(result.workflow);
    return okWithEtag(req, {
      workflow,
      recordVersion: result.recordVersion,
      ...(result.completionSummary !== undefined
        ? { completionSummary: result.completionSummary }
        : {}),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }

  async handleCancel(req: ValidatedCancelWorkflowRequest) {
    const v = req.validatedCancelWorkflow;
    const result = await this.engine.cancel({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
      reason: v.reason,
    });
    return this.workflowOk(req, result);
  }

  async handleStepStart(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.startStep(cmd));
  }

  async handleStepComplete(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.completeStep(cmd));
  }

  async handleStepSkip(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.skipStep(cmd));
  }

  async handleStepWait(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.waitStep(cmd));
  }

  async handleStepBlock(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.blockStep(cmd));
  }

  async handleStepResume(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.resumeStep(cmd));
  }

  async handleStepDefer(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.deferStep(cmd));
  }

  async handleStepCancel(req: ValidatedStepActionRequest) {
    return this.stepAction(req, (cmd) => this.engine.cancelStep(cmd));
  }

  async handleStepAssign(req: ValidatedAssignStepRequest) {
    const v = req.validatedAssignStep;
    const result = await this.engine.assignStep({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      assigneeType: v.assigneeType as AssigneeType,
      assigneeId: v.assigneeId,
      reason: v.reason,
    });
    const step = toWorkflowStepHttpDto(result.step);
    return okWithEtag(req, {
      ...step,
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }

  private async stepAction(
    req: ValidatedStepActionRequest,
    invoke: (cmd: {
      organizationId: string;
      workflowId: string;
      stepId: string;
      ifMatch?: string;
      recordVersion?: number;
      actorId?: string;
      correlationId?: string;
      reason?: string;
      idempotencyKey?: string;
      idempotencyScope?: 'http' | 'event';
    }) => Promise<{ step: Parameters<typeof toWorkflowStepHttpDto>[0]; recordVersion: number; replayed?: boolean }>,
  ) {
    const v = req.validatedStepAction;
    const result = await invoke({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
    });
    const step = toWorkflowStepHttpDto(result.step);
    return okWithEtag(req, {
      ...step,
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }

  private workflowOk(
    req: { context: { correlationId?: string } },
    result: {
      workflow: Parameters<typeof toWorkflowInstanceHttpDto>[0];
      recordVersion: number;
      replayed?: boolean;
    },
  ) {
    const workflow = toWorkflowInstanceHttpDto(result.workflow);
    return okWithEtag(req as never, {
      ...workflow,
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }

  async handleGetChecklist(req: ValidatedGetChecklistRequest) {
    const v = req.validatedGetChecklist;
    const result = await this.engine.getChecklist({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      checklistId: v.checklistId,
    });
    return okWithEtag(req, toWorkflowChecklistHttpDto(result));
  }

  async handleListChecklists(req: ValidatedListWorkflowChecklistsRequest) {
    const v = req.validatedListWorkflowChecklists;
    const items = await this.engine.listChecklist({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
    });
    return okData(req, {
      items: items.map(toWorkflowChecklistHttpDto),
    });
  }

  async handleListChecklistsByStep(req: ValidatedListStepChecklistsRequest) {
    const v = req.validatedListStepChecklists;
    const items = await this.engine.listChecklistByStep({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
    });
    return okData(req, {
      items: items.map(toWorkflowChecklistHttpDto),
    });
  }

  async handleChecklistStart(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.startChecklist(cmd));
  }

  async handleChecklistComplete(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.completeChecklist(cmd));
  }

  async handleChecklistSkip(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.skipChecklist(cmd));
  }

  async handleChecklistDefer(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.deferChecklist(cmd));
  }

  async handleChecklistBlock(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.blockChecklist(cmd));
  }

  async handleChecklistResume(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.resumeChecklist(cmd));
  }

  async handleChecklistCancel(req: ValidatedChecklistActionRequest) {
    return this.checklistAction(req, (cmd) => this.engine.cancelChecklist(cmd));
  }

  async handleChecklistAssign(req: ValidatedAssignChecklistRequest) {
    const v = req.validatedAssignChecklist;
    const result = await this.engine.assignChecklist({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      checklistId: v.checklistId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      assigneeType: v.assigneeType as AssigneeType,
      assigneeId: v.assigneeId,
      reason: v.reason,
    });
    return okWithEtag(req, {
      ...toWorkflowChecklistHttpDto(result.checklist),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }

  async handleAddStep(req: ValidatedAddWorkflowStepRequest) {
    const v = req.validatedAddWorkflowStep;
    const result = await this.engine.addStep({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
      stepId: v.step.stepId,
      name: v.step.name,
      requirement: v.step.requirement,
      allowSkip: v.step.allowSkip,
      allowDefer: v.step.allowDefer,
      condition: v.step.condition,
      assigneeType: v.step.assigneeType as AssigneeType | undefined,
      assigneeId: v.step.assigneeId,
      sortOrder: v.step.sortOrder,
    });
    return createdWithEtag(req, {
      workflowId: v.workflowId,
      recordVersion: result.workflowRecordVersion,
      step: toWorkflowStepHttpDto(result.step),
    });
  }

  async handleRemoveStep(req: ValidatedRemoveWorkflowStepRequest) {
    const v = req.validatedRemoveWorkflowStep;
    const result = await this.engine.removeStep({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
    });
    return okWithEtag(req, {
      workflowId: v.workflowId,
      recordVersion: result.workflowRecordVersion,
      stepId: result.stepId,
      removedChecklistIds: result.removedChecklistIds,
    });
  }

  async handleAddChecklist(req: ValidatedAddStepChecklistRequest) {
    const v = req.validatedAddStepChecklist;
    const result = await this.engine.addChecklist({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
      checklistId: v.checklist.checklistId,
      itemName: v.checklist.itemName,
      instruction: v.checklist.instruction,
      required: v.checklist.required,
      allowSkip: v.checklist.allowSkip,
      allowDefer: v.checklist.allowDefer,
      blocksStepCompletion: v.checklist.blocksStepCompletion,
      sortOrder: v.checklist.sortOrder,
    });
    return createdWithEtag(req, {
      workflowId: v.workflowId,
      recordVersion: result.workflowRecordVersion,
      checklist: toWorkflowChecklistHttpDto(result.checklist),
    });
  }

  async handleRemoveChecklist(req: ValidatedRemoveStepChecklistRequest) {
    const v = req.validatedRemoveStepChecklist;
    const result = await this.engine.removeChecklist({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      checklistId: v.checklistId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
    });
    return okWithEtag(req, {
      workflowId: v.workflowId,
      recordVersion: result.workflowRecordVersion,
      stepId: result.stepId,
      checklistId: result.checklistId,
    });
  }

  private async checklistAction(
    req: ValidatedChecklistActionRequest,
    invoke: (cmd: {
      organizationId: string;
      workflowId: string;
      stepId: string;
      checklistId: string;
      ifMatch?: string;
      recordVersion?: number;
      actorId?: string;
      correlationId?: string;
      reason?: string;
      idempotencyKey?: string;
      idempotencyScope?: 'http' | 'event';
    }) => Promise<{
      checklist: Parameters<typeof toWorkflowChecklistHttpDto>[0];
      recordVersion: number;
      replayed?: boolean;
    }>,
  ) {
    const v = req.validatedChecklistAction;
    const result = await invoke({
      organizationId: v.organizationId,
      workflowId: v.workflowId,
      stepId: v.stepId,
      checklistId: v.checklistId,
      ifMatch: v.ifMatch,
      recordVersion: v.recordVersion,
      actorId: v.userId,
      correlationId: v.correlationId,
      reason: v.reason,
      idempotencyKey: v.idempotencyKey,
      idempotencyScope: 'http',
    });
    return okWithEtag(req, {
      ...toWorkflowChecklistHttpDto(result.checklist),
      ...(result.replayed !== undefined ? { replayed: result.replayed } : {}),
    });
  }
}
