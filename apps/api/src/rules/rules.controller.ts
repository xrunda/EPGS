import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BadRequestException } from '@nestjs/common';
import { RulesService } from './rules.service';
import { RulesImportService } from './import/rules-import.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { ListRulesQueryDto } from './dto/list-rules.query.dto';
import { ImportConfirmDto } from './dto/import-confirm.dto';
import { RulesWriteGuard } from '../common/guards/rules-write.guard';
import { MonitorRuleDto, PaginatedMonitorRules, ImportValidateResult, ImportConfirmResult } from '@epgs/shared-types';

/**
 * multer's in-memory storage is fine here: import files are small
 * (keyword lists, not report bodies) and are never written to disk or
 * logged - see RulesImportService for the actual parse/validate/write
 * logic. Max size guards against accidental huge uploads.
 */
const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024; // 5 MiB

@ApiTags('rules')
@Controller('api/rules')
export class RulesController {
  constructor(
    private readonly rulesService: RulesService,
    private readonly importService: RulesImportService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List monitor rules, filterable by keyword/level/status/category, paginated.' })
  list(@Query() query: ListRulesQueryDto): Promise<PaginatedMonitorRules> {
    return this.rulesService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one monitor rule by id.' })
  getById(@Param('id', new ParseUUIDPipe()) id: string): Promise<MonitorRuleDto> {
    return this.rulesService.getById(id);
  }

  @Post()
  @UseGuards(RulesWriteGuard)
  @ApiOperation({ summary: 'Create a new monitor rule. Placeholder auth guard - see RulesWriteGuard.' })
  create(@Body() dto: CreateRuleDto): Promise<MonitorRuleDto> {
    return this.rulesService.create(dto);
  }

  @Put(':id')
  @UseGuards(RulesWriteGuard)
  @ApiOperation({
    summary:
      'Edit a monitor rule (keyword/level/matchField/matchMode/category/notes/isEnabled). ' +
      'Requires the current `version` for optimistic locking (409 RULE_VERSION_CONFLICT on mismatch). ' +
      'Changing matching semantics creates a new versioned row instead of overwriting - see MonitorRule.version doc.',
  })
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateRuleDto): Promise<MonitorRuleDto> {
    return this.rulesService.update(id, dto);
  }

  @Post('import/validate')
  @UseGuards(RulesWriteGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_FILE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: 'Pre-validate a CSV of rules to import. Writes nothing to the database; returns per-row errors and an importToken for /confirm.',
  })
  validateImport(@UploadedFile() file?: Express.Multer.File): ImportValidateResult {
    if (!file) {
      throw new BadRequestException({ code: 'IMPORT_FILE_MISSING', message: 'No file uploaded (expected multipart field "file").' });
    }
    return this.importService.validate(file.buffer);
  }

  @Post('import/confirm')
  @UseGuards(RulesWriteGuard)
  @ApiOperation({ summary: 'Confirm and write a previously-validated import batch (see /import/validate).' })
  confirmImport(@Body() dto: ImportConfirmDto): Promise<ImportConfirmResult> {
    return this.importService.confirm(dto.importToken, dto.actorId);
  }
}
