import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { AuditAction, AppRole } from '@prisma/client';
import { RulesService } from './rules.service';
import { RulesImportService } from './import/rules-import.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules.query.dto';
import { ImportConfirmDto } from './dto/import-confirm.dto';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, RequireRoles } from '../access/access.decorators';
import { AccessUser, pickPrimaryRole } from '../access/access-user';
import {
  MonitorRuleDto,
  PaginatedMonitorRules,
  ImportValidateResult,
  ImportConfirmResult,
} from '@epgs/shared-types';

/**
 * multer's in-memory storage is fine here: import files are small
 * (keyword lists, not report bodies) and are never written to disk or
 * logged - see RulesImportService for the actual parse/validate/write
 * logic. Max size guards against accidental huge uploads.
 */
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Issue #13 authorization: reads (GET) are open to any authenticated user;
 * writes (create/update/import) require the RULE_ADMIN role. The actor on
 * every written row and every audit entry is the authenticated username -
 * dto.actorId is ignored for authentication but kept for DTO compatibility.
 * Every write records an audit row (RULE_CREATE/RULE_UPDATE/RULE_IMPORT)
 * with rule semantics only - never patient data.
 */
@ApiTags('rules')
@Controller('api/rules')
export class RulesController {
  constructor(
    private readonly rulesService: RulesService,
    private readonly importService: RulesImportService,
    private readonly audit: AuditService,
  ) {}

  /** Server-side actor for writes: authenticated username is authoritative. */
  private actor(user: AccessUser | null, dtoActorId: string): string {
    return user?.username ?? dtoActorId;
  }

  @Get()
  @ApiOperation({
    summary: 'List monitor rules, filterable by keyword/level/status/category, paginated.',
  })
  list(@Query() query: ListRulesQueryDto): Promise<PaginatedMonitorRules> {
    return this.rulesService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one monitor rule by id.' })
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<MonitorRuleDto> {
    return this.rulesService.getById(id);
  }

  @Post()
  @RequireRoles(AppRole.RULE_ADMIN)
  @ApiOperation({ summary: 'Create a new monitor rule (RULE_ADMIN only).' })
  async create(
    @Body() dto: CreateRuleDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<MonitorRuleDto> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.rulesService.create(dto, actor);
    await this.audit.record({
      action: AuditAction.RULE_CREATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_rule',
      resourceId: result.id,
      meta: {
        keyword: result.keyword,
        level: result.level,
        matchField: result.matchField,
        matchMode: result.matchMode,
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
      'Edit a monitor rule (keyword/level/matchField/matchMode/category/notes/isEnabled). ' +
      'Requires the current `version` for optimistic locking (409 RULE_VERSION_CONFLICT on mismatch). ' +
      'Changing matching semantics creates a new versioned row instead of overwriting - see MonitorRule.version doc. (RULE_ADMIN only)',
  })
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<MonitorRuleDto> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.rulesService.update(id, dto, actor);
    await this.audit.record({
      action: AuditAction.RULE_UPDATE,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_rule',
      resourceId: id,
      meta: {
        keyword: result.keyword,
        level: result.level,
        matchField: result.matchField,
        matchMode: result.matchMode,
        version: result.version,
        isEnabled: result.isEnabled,
      },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }

  @Post('import/validate')
  @RequireRoles(AppRole.RULE_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @ApiOperation({
    summary:
      'Pre-validate a CSV of rules to import (RULE_ADMIN only). Writes nothing to the database; returns per-row errors and an importToken for /confirm.',
  })
  validateImport(@UploadedFile() file?: Express.Multer.File): ImportValidateResult {
    if (!file) {
      throw new BadRequestException({
        code: 'IMPORT_FILE_MISSING',
        message: 'No file uploaded (expected multipart field "file").',
      });
    }
    return this.importService.validate(file.buffer);
  }

  @Post('import/confirm')
  @RequireRoles(AppRole.RULE_ADMIN)
  @ApiOperation({
    summary:
      'Confirm and write a previously-validated import batch (RULE_ADMIN only, see /import/validate).',
  })
  async confirmImport(
    @Body() dto: ImportConfirmDto,
    @CurrentUser() user: AccessUser | null,
    @Req() request: Request,
  ): Promise<ImportConfirmResult> {
    const actor = this.actor(user, dto.actorId);
    const result = await this.importService.confirm(dto.importToken, actor);
    await this.audit.record({
      action: AuditAction.RULE_IMPORT,
      actorUsername: user?.username ?? null,
      actorRole: user ? pickPrimaryRole(user.roles) : null,
      resourceType: 'monitor_rule',
      meta: { createdCount: result.createdCount },
      ip: request.ip,
      correlationId: request.correlationId,
    });
    return result;
  }
}
