import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { LIMITS } from '@fundchain/shared';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { ClientIp, CurrentUser, type CurrentUserPayload, Public, Roles } from '../../common/auth';
import { RATE_LIMIT } from '../../common/rate-limits';
import { createSignedQuery, verifySignedQuery } from '../../common/signed-link';
import { AuditService } from '../audit/audit.service';
import { CreateCampaignDto, ListCampaignsQuery, ReasonDto, UpdateCampaignDto } from './campaigns.dto';
import { CampaignsService } from './campaigns.service';

export const uploadInterceptor = (field: string) =>
  FileInterceptor(field, { storage: memoryStorage(), limits: { fileSize: LIMITS.FILE_MAX_BYTES, files: 1 } });

@Controller()
export class CampaignsController {
  constructor(
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Get('campaigns')
  list(@Query() query: ListCampaignsQuery, @CurrentUser() user?: CurrentUserPayload) {
    return this.campaigns.list(query, user);
  }

  @Public()
  @Get('campaigns/:id')
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: CurrentUserPayload) {
    return this.campaigns.getDetail(id, user);
  }

  @Public()
  @Get('campaigns/:id/activity')
  async activity(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: CurrentUserPayload) {
    await this.campaigns.getDetail(id, user);
    return this.audit.campaignActivity(id);
  }

  @Throttle(RATE_LIMIT.WRITE)
  @Post('campaigns')
  create(@Body() dto: CreateCampaignDto, @CurrentUser() user: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.campaigns.create(dto, user, ip);
  }

  @Throttle(RATE_LIMIT.WRITE)
  @Patch('campaigns/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
    @CurrentUser() user: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.campaigns.update(id, dto, user, ip);
  }

  @Throttle(RATE_LIMIT.UPLOAD)
  @Post('campaigns/:id/documents')
  @UseInterceptors(uploadInterceptor('file'))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.campaigns.uploadDocument(id, file, user, ip);
  }

  @Throttle(RATE_LIMIT.WRITE)
  @Post('campaigns/:id/submit')
  submit(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.campaigns.submit(id, user, ip);
  }

  /** Link file bertanda tangan (5 menit) — otorisasi dicek di sini, saat header identitas masih ada. */
  @Public()
  @Get('documents/:id/link')
  async link(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: CurrentUserPayload) {
    await this.campaigns.assertDocumentVisible(id, user);
    return { url: `/api/v1/documents/${id}/file?${createSignedQuery(`document:${id}`)}` };
  }

  @Public()
  @Get('documents/:id/file')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
    @Query('e') e?: string,
    @Query('t') t?: string,
    @CurrentUser() user?: CurrentUserPayload,
  ) {
    const signedOk = verifySignedQuery(`document:${id}`, e, t);
    const { doc, stream } = await this.campaigns.openDocument(id, user, signedOk);
    res.setHeader('Content-Type', doc.fileType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.originalName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(stream);
  }
}

@Controller('admin/campaigns')
@Roles('ADMIN')
export class AdminCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get()
  list(@Query() query: ListCampaignsQuery) {
    // Admin boleh melihat semua status; default antrean review.
    const status = query.status === 'ALL' ? '' : query.status || 'PENDING_REVIEW';
    return this.campaigns.list({ ...query, status }, undefined, true);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload) {
    return this.campaigns.getDetail(id, admin);
  }

  @Post(':id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.campaigns.review(id, 'APPROVE', admin, null, ip);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() admin: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.campaigns.review(id, 'REJECT', admin, dto.reason, ip);
  }

  @Post(':id/freeze')
  freeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() admin: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.campaigns.adminFreeze(id, admin, dto.reason, ip);
  }

  @Post(':id/unfreeze')
  unfreeze(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() admin: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.campaigns.unfreeze(id, admin, dto.reason, ip);
  }
}
