import { BaseError } from '@api-hub/utils';
import { createLogger } from '@api-hub/observability';
import {
  OrgWorkflowTemplateForkService,
  pickTemplateCatalogMetadata,
  TEMPLATE_SCOPE,
  templateStepsToInput,
  WORKFLOW_TEMPLATE_METADATA_FIELDS,
  WorkflowTemplateNotFoundError,
  WorkflowTemplateQueryRepository,
  WorkflowTemplateValidationError,
  WorkflowTemplateWriteRepository,
  type TemplateStepInput,
  type WorkflowTemplateAggregate,
  type WorkflowTemplateCatalogMetadata,
  type WorkflowTemplateMetadataDdbRecord,
} from '@api-hub/workflow-runtime-core';

import {
  enrichTemplateHttpDtoWithActorNames,
  enrichTemplateSummariesWithUpdatedByNames,
} from '../infrastructure/user/enrich-template-updated-by-names';
import {
  toTemplateHistoryHttpDto,
  toTemplateHttpDto,
  toTemplateHttpDtoFromMetadataOnly,
  toTemplateSummaryHttpDto,
} from '../mappers/workflow-template-http.mapper';
import {
  createdWithEtag,
  okData,
  okWithEtag,
} from '../utils/definition-http-response';
import type {
  ValidatedCloneWorkflowTemplateRequest,
  ValidatedCreateWorkflowTemplateRequest,
  ValidatedGetWorkflowTemplateRequest,
  ValidatedInactivateWorkflowTemplateRequest,
  ValidatedListWorkflowTemplateHistoryRequest,
  ValidatedListWorkflowTemplatesRequest,
  ValidatedPublishWorkflowTemplateRequest,
  ValidatedUpdateWorkflowTemplateRequest,
  ValidatedEnsureOrgWorkflowTemplatesFromPlatformRequest,
  ValidatedCloneOrgWorkflowTemplatesForCarePlanRequest,
  ValidatedPublishMappedOrgWorkflowTemplatesRequest,
} from '../validators/workflow-template.validators';

function remapTemplateError(err: unknown): never {
  if (err instanceof WorkflowTemplateValidationError) {
    const maxSteps = err.details?.some(
      (d) =>
        d.code === 'MAX_WORKFLOW_STEPS_EXCEEDED' ||
        d.code === 'MAX_STEPS_EXCEEDED' ||
        d.code === 'MAX_WORKFLOW_TEMPLATE_STEPS_EXCEEDED',
    );
    if (maxSteps) {
      throw new BaseError(err.message, 422, 'MAX_STEPS_EXCEEDED', err.details, {
        retryable: false,
      });
    }
  }
  throw err;
}

function matchesListFilters(
  item: WorkflowTemplateMetadataDdbRecord,
  filters: WorkflowTemplateCatalogMetadata & {
    templateId?: string;
    workflowType?: string;
    status?: string;
    program?: string;
    condition?: string;
    basedOn?: string;
  },
): boolean {
  if (filters.templateId && item.templateId !== filters.templateId) {
    return false;
  }
  if (filters.workflowType && item.workflowType !== filters.workflowType) {
    return false;
  }
  if (filters.status && item.status !== filters.status) {
    return false;
  }
  if (filters.program && item.program !== filters.program) {
    return false;
  }
  if (filters.condition && item.condition !== filters.condition) {
    return false;
  }
  if (filters.basedOn && item.basedOn !== filters.basedOn) {
    return false;
  }
  return WORKFLOW_TEMPLATE_METADATA_FIELDS.every(
    (field) => !filters[field] || item[field] === filters[field],
  );
}

/** Clone inherits the source's catalog metadata unless the body overrides it. */
function mergeCatalogMetadata(
  source: WorkflowTemplateCatalogMetadata,
  overrides: WorkflowTemplateCatalogMetadata,
): WorkflowTemplateCatalogMetadata {
  const merged = pickTemplateCatalogMetadata(source);
  for (const field of WORKFLOW_TEMPLATE_METADATA_FIELDS) {
    if (overrides[field] !== undefined) {
      merged[field] = overrides[field];
    }
  }
  return merged;
}

let ctrl: WorkflowTemplateHttpController | undefined;

export function getWorkflowTemplateHttpController(deps?: {
  write?: WorkflowTemplateWriteRepository;
  query?: WorkflowTemplateQueryRepository;
  fork?: OrgWorkflowTemplateForkService;
}): WorkflowTemplateHttpController {
  if (!ctrl) {
    ctrl = new WorkflowTemplateHttpController(deps);
  }
  return ctrl;
}

/** Test seam. */
export function resetWorkflowTemplateHttpControllerForTests(): void {
  ctrl = undefined;
}

export class WorkflowTemplateHttpController {
  private readonly write: WorkflowTemplateWriteRepository;
  private readonly query: WorkflowTemplateQueryRepository;
  private readonly fork: OrgWorkflowTemplateForkService;
  private readonly logger = createLogger({
    serviceName: 'workflow-template-http',
  });

  constructor(deps?: {
    write?: WorkflowTemplateWriteRepository;
    query?: WorkflowTemplateQueryRepository;
    fork?: OrgWorkflowTemplateForkService;
  }) {
    this.write = deps?.write ?? new WorkflowTemplateWriteRepository();
    this.query = deps?.query ?? new WorkflowTemplateQueryRepository();
    this.fork =
      deps?.fork ??
      new OrgWorkflowTemplateForkService(this.query, this.write);
  }

  async handleCreate(req: ValidatedCreateWorkflowTemplateRequest) {
    const { validatedCreateWorkflowTemplate: v } = req;
    try {
      const aggregate =
        v.scope === TEMPLATE_SCOPE.PLATFORM
          ? await this.write.createPlatformTemplate({
              templateId: v.body.templateId,
              templateName: v.body.templateName,
              workflowType: v.body.workflowType,
              workflowStage: v.body.workflowStage,
              description: v.body.description,
              program: v.body.program,
              condition: v.body.condition,
              basedOn: v.body.basedOn,
              ...pickTemplateCatalogMetadata(v.body),
              defaultAssignee: v.body.defaultAssignee,
              steps: v.body.steps as TemplateStepInput[],
              createdBy: v.userId,
            })
          : await this.write.createOrgTemplate({
              organizationId: v.organizationId!,
              templateId: v.body.templateId,
              templateName: v.body.templateName,
              workflowType: v.body.workflowType,
              workflowStage: v.body.workflowStage,
              description: v.body.description,
              program: v.body.program,
              condition: v.body.condition,
              basedOn: v.body.basedOn,
              ...pickTemplateCatalogMetadata(v.body),
              platformTemplateId: v.body.platformTemplateId,
              defaultAssignee: v.body.defaultAssignee,
              steps: v.body.steps as TemplateStepInput[],
              createdBy: v.userId,
            });
      return createdWithEtag(req, toTemplateHttpDto(aggregate));
    } catch (err) {
      remapTemplateError(err);
    }
  }

  async handleUpdate(req: ValidatedUpdateWorkflowTemplateRequest) {
    const { validatedUpdateWorkflowTemplate: v } = req;
    try {
      const aggregate = await this.write.updateDraft({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
        expectedRecordVersion: v.expectedRecordVersion,
        templateName: v.body.templateName,
        description: v.body.description,
        program: v.body.program,
        condition: v.body.condition,
        basedOn: v.body.basedOn,
        ...pickTemplateCatalogMetadata(v.body),
        platformTemplateId: v.body.platformTemplateId,
        defaultAssignee: v.body.defaultAssignee,
        steps: v.body.steps as TemplateStepInput[],
        updatedBy: v.userId,
      });
      return okWithEtag(req, toTemplateHttpDto(aggregate));
    } catch (err) {
      remapTemplateError(err);
    }
  }

  async handlePublish(req: ValidatedPublishWorkflowTemplateRequest) {
    const { validatedPublishWorkflowTemplate: v } = req;
    try {
      const aggregate = await this.write.publish({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
        expectedRecordVersion: v.expectedRecordVersion,
        updatedBy: v.userId,
      });
      return okWithEtag(req, toTemplateHttpDto(aggregate));
    } catch (err) {
      remapTemplateError(err);
    }
  }

  async handleInactivate(req: ValidatedInactivateWorkflowTemplateRequest) {
    const { validatedInactivateWorkflowTemplate: v } = req;
    try {
      const record = await this.write.inactivate({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
        expectedRecordVersion: v.expectedRecordVersion,
        updatedBy: v.userId,
      });
      return okWithEtag(req, toTemplateHttpDtoFromMetadataOnly(record));
    } catch (err) {
      remapTemplateError(err);
    }
  }

  /**
   * Clone via get + create (no dedicated write-repo clone; HTTP-only composition).
   */
  async handleClone(req: ValidatedCloneWorkflowTemplateRequest) {
    const { validatedCloneWorkflowTemplate: v } = req;
    try {
      const source = await this.query.getTemplate({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
      });
      if (!source) {
        throw new WorkflowTemplateNotFoundError(
          `Workflow template ${v.templateId} not found`,
        );
      }

      const steps =
        (v.body.steps as TemplateStepInput[] | undefined) ??
        templateStepsToInput(source.steps, source.checklists);

      const aggregate = await this.createFromSource(source, {
        scope: v.scope,
        organizationId: v.organizationId,
        userId: v.userId,
        templateId: v.body.templateId,
        templateName: v.body.templateName ?? source.metadata.templateName,
        description:
          v.body.description !== undefined
            ? v.body.description
            : source.metadata.description,
        program:
          v.body.program !== undefined
            ? v.body.program
            : source.metadata.program,
        condition:
          v.body.condition !== undefined
            ? v.body.condition
            : source.metadata.condition,
        basedOn:
          v.body.basedOn !== undefined
            ? v.body.basedOn
            : source.metadata.basedOn,
        ...mergeCatalogMetadata(source.metadata, v.body),
        platformTemplateId:
          v.body.platformTemplateId ??
          ('platformTemplateId' in source.metadata
            ? source.metadata.platformTemplateId
            : source.metadata.templateId),
        defaultAssignee:
          v.body.defaultAssignee ?? source.metadata.defaultAssignee,
        steps,
      });

      return createdWithEtag(req, toTemplateHttpDto(aggregate));
    } catch (err) {
      remapTemplateError(err);
    }
  }

  /**
   * S2S: ensure an org-scoped copy exists for each mapped platform (or already-org) template.
   */
  async handleEnsureFromPlatform(
    req: ValidatedEnsureOrgWorkflowTemplatesFromPlatformRequest,
  ) {
    const { validatedEnsureOrgWorkflowTemplatesFromPlatform: v } = req;
    try {
      this.logger.info({
        event: 'workflow_template_from_platform_start',
        organizationId: v.organizationId,
        mappingCount: v.body.mappings.length,
        platformTemplateIds: v.body.mappings.map(
          (item) => item.workflowTemplateId,
        ),
      });
      const mappings = await this.fork.ensureOrgCopies({
        organizationId: v.organizationId,
        mappings: v.body.mappings,
        createdBy: v.userId,
      });
      this.logger.info({
        event: 'workflow_template_from_platform_success',
        organizationId: v.organizationId,
        mappings,
      });
      return okData(req, { mappings });
    } catch (err) {
      this.logger.error({
        event: 'workflow_template_from_platform_failed',
        organizationId: v.organizationId,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      });
      remapTemplateError(err);
    }
  }

  /**
   * S2S: clone Org Template workflows into new Care Plan–scoped org drafts.
   * Reuses the same createOrgTemplate write path as HTTP org clone.
   */
  async handleCloneOrgTemplatesForCarePlan(
    req: ValidatedCloneOrgWorkflowTemplatesForCarePlanRequest,
  ) {
    const { validatedCloneOrgWorkflowTemplatesForCarePlan: v } = req;
    try {
      this.logger.info({
        event: 'workflow_template_care_plan_clone_start',
        organizationId: v.organizationId,
        carePlanTemplateId: v.body.carePlanTemplateId,
        mappingCount: v.body.mappings.length,
        sourceTemplateIds: v.body.mappings.map(
          (item) => item.workflowTemplateId,
        ),
      });
      const mappings = await this.fork.cloneOrgTemplatesForCarePlan({
        organizationId: v.organizationId,
        carePlanTemplateId: v.body.carePlanTemplateId,
        mappings: v.body.mappings,
        createdBy: v.userId,
      });
      this.logger.info({
        event: 'workflow_template_care_plan_clone_success',
        organizationId: v.organizationId,
        carePlanTemplateId: v.body.carePlanTemplateId,
        mappings,
      });
      return okData(req, { mappings });
    } catch (err) {
      this.logger.error({
        event: 'workflow_template_care_plan_clone_failed',
        organizationId: v.organizationId,
        carePlanTemplateId: v.body.carePlanTemplateId,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      });
      remapTemplateError(err);
    }
  }

  /**
   * S2S: publish org workflow templates by id (Org Template catalog publish).
   * Org-scoped get only — never publishes platform templates.
   */
  async handlePublishMappedOrgTemplates(
    req: ValidatedPublishMappedOrgWorkflowTemplatesRequest,
  ) {
    const { validatedPublishMappedOrgWorkflowTemplates: v } = req;
    try {
      const result = await this.fork.publishOrgTemplatesByIds({
        organizationId: v.organizationId,
        workflowTemplateIds: v.body.workflowTemplateIds,
        updatedBy: v.userId,
      });
      return okData(req, result);
    } catch (err) {
      remapTemplateError(err);
    }
  }

  async handleGet(req: ValidatedGetWorkflowTemplateRequest) {
    const { validatedGetWorkflowTemplate: v } = req;
    const aggregate = await this.query.getTemplate({
      scope: v.scope,
      organizationId: v.organizationId,
      templateId: v.templateId,
    });
    if (!aggregate) {
      throw new WorkflowTemplateNotFoundError(
        `Workflow template ${v.templateId} not found`,
      );
    }
    return okWithEtag(
      req,
      await enrichTemplateHttpDtoWithActorNames(toTemplateHttpDto(aggregate)),
    );
  }

  async handleListHistory(req: ValidatedListWorkflowTemplateHistoryRequest) {
    const { validatedListWorkflowTemplateHistory: v } = req;
    try {
      const page = await this.query.listHistory({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
        limit: v.limit,
        cursor: v.cursor,
      });
      return okData(req, {
        items: page.items.map(toTemplateHistoryHttpDto),
        nextCursor: page.nextCursor ?? null,
      });
    } catch (err) {
      remapTemplateError(err);
    }
  }

  async handleList(req: ValidatedListWorkflowTemplatesRequest) {
    const { validatedListWorkflowTemplates: v } = req;

    if (v.templateId && !v.workflowStage && !v.status) {
      const aggregate = await this.query.getTemplate({
        scope: v.scope,
        organizationId: v.organizationId,
        templateId: v.templateId,
      });
      if (!aggregate) {
        return okData(req, { items: [], nextCursor: null });
      }
      if (
        !matchesListFilters(aggregate.metadata, {
          workflowType: v.workflowType,
          status: v.status,
          program: v.program,
          condition: v.condition,
          basedOn: v.basedOn,
          ...pickTemplateCatalogMetadata(v),
        })
      ) {
        return okData(req, { items: [], nextCursor: null });
      }
      const items = await enrichTemplateSummariesWithUpdatedByNames([
        toTemplateSummaryHttpDto(aggregate.metadata),
      ]);
      return okData(req, {
        items,
        nextCursor: null,
      });
    }

    const page = await this.query.listTemplates({
      scope: v.scope,
      organizationId: v.organizationId,
      workflowStage: v.workflowStage,
      status: v.status,
      limit: v.limit,
      cursor: v.cursor,
    });

    const items = await enrichTemplateSummariesWithUpdatedByNames(
      page.items
        .filter((item) =>
          matchesListFilters(item, {
            templateId: v.templateId,
            workflowType: v.workflowType,
            status: v.status,
            program: v.program,
            condition: v.condition,
            basedOn: v.basedOn,
            ...pickTemplateCatalogMetadata(v),
          }),
        )
        .map(toTemplateSummaryHttpDto),
    );

    return okData(req, {
      items,
      nextCursor: page.nextCursor ?? null,
    });
  }

  private async createFromSource(
    source: WorkflowTemplateAggregate,
    input: WorkflowTemplateCatalogMetadata & {
      scope: typeof TEMPLATE_SCOPE.PLATFORM | typeof TEMPLATE_SCOPE.ORGANIZATION;
      organizationId?: string;
      userId?: string;
      templateId?: string;
      templateName: string;
      description?: string;
      program?: string;
      condition?: string;
      basedOn?: string;
      platformTemplateId?: string;
      defaultAssignee?: { assigneeType: string; assigneeId: string };
      steps: TemplateStepInput[];
    },
  ): Promise<WorkflowTemplateAggregate> {
    if (input.scope === TEMPLATE_SCOPE.PLATFORM) {
      return this.write.createPlatformTemplate({
        templateId: input.templateId,
        templateName: input.templateName,
        workflowType: source.metadata.workflowType,
        workflowStage: source.metadata.workflowStage,
        description: input.description,
        program: input.program,
        condition: input.condition,
        basedOn: input.basedOn,
        ...pickTemplateCatalogMetadata(input),
        defaultAssignee: input.defaultAssignee as never,
        steps: input.steps,
        createdBy: input.userId,
      });
    }
    return this.write.createOrgTemplate({
      organizationId: input.organizationId!,
      templateId: input.templateId,
      templateName: input.templateName,
      workflowType: source.metadata.workflowType,
      workflowStage: source.metadata.workflowStage,
      description: input.description,
      program: input.program,
      condition: input.condition,
      basedOn: input.basedOn,
      ...pickTemplateCatalogMetadata(input),
      platformTemplateId: input.platformTemplateId,
      defaultAssignee: input.defaultAssignee as never,
      steps: input.steps,
      createdBy: input.userId,
    });
  }
}
