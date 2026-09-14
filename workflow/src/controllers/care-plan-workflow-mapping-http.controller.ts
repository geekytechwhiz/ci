import { createLogger } from '@api-hub/observability';
import {
  CarePlanWorkflowMappingQueryRepository,
  CarePlanWorkflowMappingWriteRepository,
  OrgWorkflowTemplateForkService,
} from '@api-hub/workflow-runtime-core';

import {
  toCarePlanMappingsHttpDto,
} from '../mappers/care-plan-workflow-mapping-http.mapper';
import { okData } from '../utils/definition-http-response';
import type {
  ValidatedDeleteCarePlanWorkflowMappingRequest,
  ValidatedGetCarePlanWorkflowMappingsRequest,
  ValidatedPutCarePlanWorkflowMappingsRequest,
} from '../validators/workflow-template.validators';

let ctrl: CarePlanWorkflowMappingHttpController | undefined;

export function getCarePlanWorkflowMappingHttpController(deps?: {
  write?: CarePlanWorkflowMappingWriteRepository;
  query?: CarePlanWorkflowMappingQueryRepository;
  fork?: OrgWorkflowTemplateForkService;
}): CarePlanWorkflowMappingHttpController {
  if (!ctrl) {
    ctrl = new CarePlanWorkflowMappingHttpController(deps);
  }
  return ctrl;
}

/** Test seam. */
export function resetCarePlanWorkflowMappingHttpControllerForTests(): void {
  ctrl = undefined;
}

type WorkflowMappingRef = {
  workflowStage: string;
  workflowTemplateId: string;
};

function sameMappingRefs(
  left: WorkflowMappingRef[],
  right: WorkflowMappingRef[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every(
    (item, index) =>
      item.workflowStage === right[index]?.workflowStage &&
      item.workflowTemplateId === right[index]?.workflowTemplateId,
  );
}

export class CarePlanWorkflowMappingHttpController {
  private readonly write: CarePlanWorkflowMappingWriteRepository;
  private readonly query: CarePlanWorkflowMappingQueryRepository;
  private readonly fork: OrgWorkflowTemplateForkService;
  private readonly logger = createLogger({
    serviceName: 'care-plan-workflow-mapping-http',
  });

  constructor(deps?: {
    write?: CarePlanWorkflowMappingWriteRepository;
    query?: CarePlanWorkflowMappingQueryRepository;
    fork?: OrgWorkflowTemplateForkService;
  }) {
    this.write = deps?.write ?? new CarePlanWorkflowMappingWriteRepository();
    this.query = deps?.query ?? new CarePlanWorkflowMappingQueryRepository();
    this.fork = deps?.fork ?? new OrgWorkflowTemplateForkService();
  }

  /**
   * Org Admin and runtime must receive org-scoped workflowTemplateIds.
   * Reuses POST /from-platform (no second fork mechanism).
   */
  private async resolveOrgWorkflowTemplateIds(
    organizationId: string,
    mappings: WorkflowMappingRef[],
    createdBy?: string,
  ): Promise<WorkflowMappingRef[]> {
    if (mappings.length === 0) {
      return mappings;
    }
    return this.fork.ensureOrgCopies({
      organizationId,
      mappings,
      createdBy,
    });
  }

  async handleGet(req: ValidatedGetCarePlanWorkflowMappingsRequest) {
    const { validatedGetCarePlanWorkflowMappings: v } = req;
    const aggregate = await this.query.getAggregate({
      organizationId: v.organizationId,
      carePlanTemplateId: v.carePlanTemplateId,
    });
    const refs = aggregate.mappings.map((item) => ({
      workflowStage: item.workflowStage,
      workflowTemplateId: item.workflowTemplateId,
    }));

    let resolved = refs;
    try {
      const next = await this.resolveOrgWorkflowTemplateIds(
        v.organizationId,
        refs,
      );
      if (Array.isArray(next) && next.length === refs.length) {
        resolved = next;
      }
    } catch (err) {
      this.logger.error({
        event: 'care_plan_mapping_fork_heal_failed',
        organizationId: v.organizationId,
        carePlanTemplateId: v.carePlanTemplateId,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      });
      throw err;
    }

    if (resolved.length === refs.length && !sameMappingRefs(refs, resolved)) {
      const mappings = await this.write.putMappings({
        organizationId: v.organizationId,
        carePlanTemplateId: v.carePlanTemplateId,
        mappings: resolved,
        createdBy: v.userId,
      });
      return okData(
        req,
        toCarePlanMappingsHttpDto({
          organizationId: v.organizationId,
          carePlanTemplateId: v.carePlanTemplateId,
          mappings,
        }),
      );
    }

    return okData(
      req,
      toCarePlanMappingsHttpDto({
        organizationId: aggregate.organizationId,
        carePlanTemplateId: aggregate.carePlanTemplateId,
        mappings: aggregate.mappings,
      }),
    );
  }

  async handlePut(req: ValidatedPutCarePlanWorkflowMappingsRequest) {
    const { validatedPutCarePlanWorkflowMappings: v } = req;
    const resolved = await this.resolveOrgWorkflowTemplateIds(
      v.organizationId,
      v.body.mappings,
      v.userId,
    );
    const mappings = await this.write.putMappings({
      organizationId: v.organizationId,
      carePlanTemplateId: v.carePlanTemplateId,
      mappings: resolved,
      createdBy: v.userId,
    });
    return okData(
      req,
      toCarePlanMappingsHttpDto({
        organizationId: v.organizationId,
        carePlanTemplateId: v.carePlanTemplateId,
        mappings,
      }),
    );
  }

  async handleDelete(req: ValidatedDeleteCarePlanWorkflowMappingRequest) {
    const { validatedDeleteCarePlanWorkflowMapping: v } = req;
    await this.write.deleteMapping({
      organizationId: v.organizationId,
      carePlanTemplateId: v.carePlanTemplateId,
      workflowStage: v.workflowStage,
      expectedRecordVersion: v.expectedRecordVersion,
    });
    return okData(req, {
      organizationId: v.organizationId,
      carePlanTemplateId: v.carePlanTemplateId,
      workflowStage: v.workflowStage,
      deleted: true,
    });
  }
}
