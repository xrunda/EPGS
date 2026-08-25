import { BadRequestException, Injectable } from '@nestjs/common';
import { NotificationMsgType, Prisma } from '@prisma/client';
import {
  NotificationChannelDto,
  NotificationTemplateDto,
  NotificationTemplatePresetDto,
  NotificationVariableDto,
  PaginatedNotificationChannels,
  PaginatedNotificationTemplates,
} from '@epgs/shared-types';
import { NotificationSecretCipher } from '@epgs/notification-push';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ListChannelsQueryDto } from './dto/list-channels.query.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { ListTemplatesQueryDto } from './dto/list-templates.query.dto';
import { toChannelDto, toTemplateDto } from './notifications.mapper';
import { NotificationChannelNotFoundException } from './errors/notification-channel-not-found.exception';
import { NotificationTemplateNotFoundException } from './errors/notification-template-not-found.exception';

/**
 * The fixed {{placeholder}} dictionary rendered by test-send (design §4,
 * issue #54). `reportDate` is computed at send time; the four counts come
 * from MonitorService.summary; `hospitalName` comes from HOSPITAL_NAME. This
 * table only documents key/label/example for the config UI.
 */
const TEMPLATE_VARIABLES: NotificationVariableDto[] = [
  { key: 'reportDate', label: '报告日期', example: '2026-08-23' },
  { key: 'hospitalName', label: '医院名称', example: '菏泽市中医医院' },
  { key: 'redCount', label: '红色关注数量', example: '3' },
  { key: 'yellowCount', label: '黄色关注数量', example: '5' },
  { key: 'greenCount', label: '绿色关注数量', example: '12' },
  { key: 'unclassifiedCount', label: '未分类数量', example: '2' },
  { key: 'totalCount', label: '总记录数', example: '22' },
  { key: 'redKeywords', label: '红色命中词（TOP5）', example: '恶性肿瘤 ×1、穿孔 ×1' },
  { key: 'yellowKeywords', label: '黄色命中词（TOP3）', example: '肿物 ×2、溃疡 ×1' },
];

/**
 * Preset content-template skeletons for the config UI (issue: template presets).
 * Static starting points so an operator doesn't have to write the initial
 * message body from scratch; the operator picks one and edits further. Tokens
 * are {{placeholders}} from the fixed dictionary above. Served read-only by
 * GET /api/notification-templates/presets.
 */
const TEMPLATE_PRESETS: NotificationTemplatePresetDto[] = [
  {
    id: 'red-alert',
    name: '红色关注提醒',
    content: '{{hospitalName}} {{reportDate}} 内镜重点患者：红色关注 {{redCount}} 例，请及时查看处理。',
  },
  {
    id: 'daily-summary',
    name: '每日关注摘要',
    content:
      '{{reportDate}} {{hospitalName}} 内镜关注汇总\n' +
      '红 {{redCount}} 例｜黄 {{yellowCount}} 例｜绿 {{greenCount}} 例｜未分级 {{unclassifiedCount}} 例｜共 {{totalCount}} 例\n' +
      '红色命中：{{redKeywords}}\n' +
      '黄色命中：{{yellowKeywords}}',
  },
  {
    id: 'quick-alert',
    name: '简明关注提醒',
    content: '{{hospitalName}} {{reportDate}} 红色 {{redCount}} 例',
  },
];

/**
 * Channel/template CRUD for the notification module (issue #54).
 *
 * SECURITY CONTRACT (design §5): webhookUrl is encrypted at rest and never
 * returned; reads expose only the masked preview. Consequently `webhookUrl`
 * never appears in this service's logs or exceptions.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: NotificationSecretCipher,
  ) {}

  private readonly decrypt = (ciphertext: string): string => this.cipher.decrypt(ciphertext);

  // ---- Channels -------------------------------------------------------

  async listChannels(query: ListChannelsQueryDto): Promise<PaginatedNotificationChannels> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.NotificationChannelWhereInput = {
      ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationChannel.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationChannel.count({ where }),
    ]);

    return {
      items: items.map((channel) => toChannelDto(channel, this.decrypt)),
      total,
      page,
      pageSize,
    };
  }

  async createChannel(dto: CreateChannelDto, actorUsername?: string): Promise<NotificationChannelDto> {
    // Issue #13: authenticated username is authoritative (dto.actorId is
    // kept only for backwards-compatible DTO shape and ignored by the
    // controller; optional here, hence the 'unknown' fallback).
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    const created = await this.prisma.notificationChannel.create({
      data: {
        name: dto.name.trim(),
        webhookUrlCiphertext: this.cipher.encrypt(dto.webhookUrl.trim()),
        isEnabled: dto.isEnabled ?? true,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    return toChannelDto(created, this.decrypt);
  }

  async updateChannel(id: string, dto: UpdateChannelDto, actorUsername?: string): Promise<NotificationChannelDto> {
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    const current = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!current) throw new NotificationChannelNotFoundException(id);

    const data: Prisma.NotificationChannelUpdateInput = {
      name: dto.name?.trim() ?? current.name,
      isEnabled: dto.isEnabled ?? current.isEnabled,
      updatedBy: actor,
    };
    // WRITE-ONLY webhookUrl: present replaces the stored value (re-encrypted
    // fresh); absent preserves the existing ciphertext untouched.
    if (dto.webhookUrl !== undefined) {
      data.webhookUrlCiphertext = this.cipher.encrypt(dto.webhookUrl.trim());
    }

    const updated = await this.prisma.notificationChannel.update({ where: { id }, data });
    return toChannelDto(updated, this.decrypt);
  }

  // ---- Templates ------------------------------------------------------

  async listTemplates(query: ListTemplatesQueryDto): Promise<PaginatedNotificationTemplates> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.NotificationTemplateWhereInput = {
      ...(query.msgType ? { msgType: query.msgType } : {}),
      ...(query.isEnabled !== undefined ? { isEnabled: query.isEnabled } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notificationTemplate.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notificationTemplate.count({ where }),
    ]);

    return {
      items: items.map(toTemplateDto),
      total,
      page,
      pageSize,
    };
  }

  async createTemplate(dto: CreateTemplateDto, actorUsername?: string): Promise<NotificationTemplateDto> {
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    const created = await this.prisma.notificationTemplate.create({
      data: {
        name: dto.name.trim(),
        msgType: dto.msgType,
        titleTemplate: this.normalizeTitle(dto.msgType, dto.titleTemplate),
        contentTemplate: dto.contentTemplate,
        coverImageUrl: dto.coverImageUrl ?? null,
        linkUrl: dto.linkUrl ?? null,
        isEnabled: dto.isEnabled ?? true,
        createdBy: actor,
        updatedBy: actor,
      },
    });
    return toTemplateDto(created);
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto, actorUsername?: string): Promise<NotificationTemplateDto> {
    const actor = actorUsername ?? dto.actorId ?? 'unknown';
    const current = await this.prisma.notificationTemplate.findUnique({ where: { id } });
    if (!current) throw new NotificationTemplateNotFoundException(id);

    const nextMsgType = dto.msgType ?? current.msgType;
    let nextTitle: string | null;
    if (dto.titleTemplate !== undefined) {
      // Caller explicitly set (or is changing) the title: validate against
      // the MERGED msgType.
      nextTitle = this.normalizeTitle(nextMsgType, dto.titleTemplate);
    } else if (nextMsgType === 'TEXT') {
      // TEXT never stores a title - keep the invariant even if the caller
      // switched a NEWS template to TEXT.
      nextTitle = null;
    } else {
      // NEWS, title untouched: the existing stored title must still be
      // present, or the merged template violates the NEWS contract.
      nextTitle = current.titleTemplate;
      if (!nextTitle?.trim()) {
        throw this.titleRequired();
      }
    }

    const updated = await this.prisma.notificationTemplate.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? current.name,
        msgType: nextMsgType,
        titleTemplate: nextTitle,
        contentTemplate: dto.contentTemplate ?? current.contentTemplate,
        coverImageUrl: dto.coverImageUrl !== undefined ? dto.coverImageUrl : current.coverImageUrl,
        linkUrl: dto.linkUrl !== undefined ? dto.linkUrl : current.linkUrl,
        isEnabled: dto.isEnabled ?? current.isEnabled,
        updatedBy: actor,
      },
    });
    return toTemplateDto(updated);
  }

  // ---- Variables / Presets -------------------------------------------

  /** The fixed placeholder dictionary (design §4). */
  getVariables(): NotificationVariableDto[] {
    return TEMPLATE_VARIABLES;
  }

  /** Preset content-template skeletons for the config UI (static starting points). */
  getPresets(): NotificationTemplatePresetDto[] {
    return TEMPLATE_PRESETS;
  }

  // ---- Helpers --------------------------------------------------------

  /**
   * Cross-field rule (design §4): a NEWS template requires a non-blank
   * title; a TEXT template never stores one (any submitted title is
   * dropped). Enforced in the service layer - not the DTO - because the
   * update path must validate against the MERGED msgType, and the
   * class-validator @ValidateIf/@IsOptional interplay can't distinguish
   * "absent" from "present-but-optional" cleanly.
   */
  private normalizeTitle(msgType: NotificationMsgType, title: string | undefined): string | null {
    if (msgType === 'TEXT') return null;
    const trimmed = title?.trim();
    if (!trimmed) {
      throw this.titleRequired();
    }
    return trimmed;
  }

  private titleRequired(): BadRequestException {
    return new BadRequestException({
      code: 'NOTIFICATION_TEMPLATE_TITLE_REQUIRED',
      message: 'titleTemplate is required when msgType is NEWS.',
    });
  }
}
