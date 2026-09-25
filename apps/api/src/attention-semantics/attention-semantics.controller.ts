import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { AttentionSemanticsService } from './attention-semantics.service';
import { CreateAttentionSemanticDto } from './dto/create-attention-semantic.dto';
import { UpdateAttentionSemanticDto } from './dto/update-attention-semantic.dto';
import { ListAttentionSemanticsQueryDto } from './dto/list-attention-semantics.query.dto';
import { ImportDefaultsDto } from './dto/import-defaults.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import {
  AttentionSemanticDto,
  PaginatedAttentionSemantics,
  ImportAttentionSemanticsResult,
} from '@epgs/shared-types';

/**
 * Attention-semantic configuration (issue #88).
 *
 * AUTHORIZATION mirrors /api/rules (issue #13): reads need only an
 * authenticated user; writes need RULE_ADMIN. Same role deliberately - "which
 * meanings this hospital watches for" is the same administrative
 * responsibility as "which keywords it watches for", and splitting it would
 * let one operator configure keywords and another configure the AI without
 * either seeing the whole picture.
 *
 * NO DELETE ENDPOINT, by design. A semantic is never removed, only disabled:
 * monitor_report_ai_match rows reference specific versions, and deleting one
 * would leave past AI findings pointing at a meaning nobody can look up - the
 * audit trail's whole purpose. So "delete" in the DoD is served by
 * `isEnabled: false` through PUT, exactly as it is for rules. The FK is
 * `onDelete: Restrict` so even a direct DB delete cannot do it quietly.
 *
 * Every write records an audit row with SEMANTIC CONFIGURATION ONLY (name,
 * colour, version) - never patient data and never report text. The AI
 * classification audit trail lives in monitor_report_ai.
 */
@ApiTags('attention-semantics')
@Controller('api/attention-semantics')
export class AttentionSemanticsController {
  constructor(
    private readonly service: AttentionSemanticsService,
    private readonly audit: AuditService,
  ) {}

  /** Server-side actor for writes: authenticated username is authoritative. */
  private actor(user: AccessUser | null, dtoActorId: string): string {
    return user?.username ?? dtoActorId;
  }

  @Get()
  @ApiOperation({
    summary:
      'List attention semantics (all versions), filterable by name/level/status, paginated.',
  })
  list(@Query() query: ListAttentionSemanticsQueryDto): Promise<PaginatedAttentionSemantics> {
    return this.service.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one attention semantic by id.' })
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<AttentionSemanticDto> {
    return this.service.getById(id);
  }

  @Post()
  @RequireRoles(AppRole.RULE_ADMIN)
  @ApiOperation({
    summary:
      'Create a new attention semantic (RULE_ADMIN only). The description is what the AI classifier reads, so write it as a statement of meaning, not a keyword.',
  })
  async create(
    @Body() dto: CreateAttentionSemanticDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<AttentionSemanticDto> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.service.create(dto, actor);
    await this.audit.record({
      action: AuditAction.ATTENTION_SEMANTIC_CREATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'attention_semantic',
      resourceId: result.id,
      meta: {
        name: result.name,
        attentionLevel: result.attentionLevel,
        version: result.version,
        isEnabled: result.isEnabled,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Put(':id')
  @RequireRoles(AppRole.RULE_ADMIN)
  @ApiOperation({
    summary:
      'Edit an attention semantic, or enable/disable it. Requires the current `version` for optimistic locking (409 ATTENTION_SEMANTIC_VERSION_CONFLICT on mismatch). ' +
      'Changing name/description/attentionLevel creates a new versioned row instead of overwriting, so historical AI findings keep pointing at the wording that was in force. (RULE_ADMIN only)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAttentionSemanticDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<AttentionSemanticDto> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.service.update(id, dto, actor);
    await this.audit.record({
      action: AuditAction.ATTENTION_SEMANTIC_UPDATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'attention_semantic',
      resourceId: id,
      meta: {
        name: result.name,
        attentionLevel: result.attentionLevel,
        version: result.version,
        isEnabled: result.isEnabled,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Post('import-defaults')
  @RequireRoles(AppRole.RULE_ADMIN)
  @ApiOperation({
    summary:
      'Explicitly load the preset attention semantics into this hospital configuration (RULE_ADMIN only). ' +
      'The ONLY way presets become active - no migration writes medical semantics. Idempotent; existing entries are left untouched unless overwriteExisting is set. ' +
      'These are generic templates, not a clinical standard: review and adapt them before relying on the results.',
  })
  async importDefaults(
    @Body() dto: ImportDefaultsDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<ImportAttentionSemanticsResult> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.service.importDefaults(dto, actor);
    await this.audit.record({
      action: AuditAction.ATTENTION_SEMANTIC_CREATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'attention_semantic',
      meta: {
        source: 'DEFAULT_TEMPLATE',
        createdCount: result.createdCount,
        skippedCount: result.skippedCount,
        updatedCount: result.updatedCount,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
