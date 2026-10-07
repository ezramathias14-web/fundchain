import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { ClientIp, CurrentUser, type CurrentUserPayload, Public, Roles } from '../../common/auth';
import { RATE_LIMIT } from '../../common/rate-limits';
import { ReasonDto } from '../campaigns/campaigns.dto';
import { uploadInterceptor } from '../campaigns/campaigns.controller';
import { DisbursementsService } from './disbursements.service';

class CreateDisbursementDto {
  @Type(() => Number)
  @IsInt({ message: 'Nominal harus bilangan bulat rupiah' })
  @Min(1)
  amount!: number;

  @IsString()
  @MaxLength(2000)
  description!: string;
}

@Controller()
export class DisbursementsController {
  constructor(private readonly disbursements: DisbursementsService) {}

  /** multipart/form-data: amount, description, proof (PDF/PNG/JPG). */
  @Throttle(RATE_LIMIT.UPLOAD)
  @Post('campaigns/:id/disbursements')
  @UseInterceptors(uploadInterceptor('proof'))
  create(
    @Param('id', ParseUUIDPipe) campaignId: string,
    @Body() dto: CreateDisbursementDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.disbursements.create(campaignId, dto, file, user, ip);
  }

  @Public()
  @Get('campaigns/:id/disbursements')
  list(@Param('id', ParseUUIDPipe) campaignId: string, @CurrentUser() user?: CurrentUserPayload) {
    return this.disbursements.listForCampaign(campaignId, user);
  }

  @Get('disbursements/:id/proof')
  async proof(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { d, stream } = await this.disbursements.openProof(id, user);
    res.setHeader('Content-Type', d.proofType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.proofName)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(stream);
  }

  @Roles('ADMIN')
  @Get('admin/disbursements')
  listAdmin(@Query('status') status?: string) {
    return this.disbursements.listAdmin(status);
  }

  @Roles('ADMIN')
  @Post('admin/disbursements/:id/approve')
  @HttpCode(200)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.disbursements.decide(id, 'APPROVE', admin, null, ip);
  }

  @Roles('ADMIN')
  @Post('admin/disbursements/:id/reject')
  @HttpCode(200)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() admin: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.disbursements.decide(id, 'REJECT', admin, dto.reason, ip);
  }

  @Roles('ADMIN')
  @Post('admin/disbursements/:id/mark-paid')
  @HttpCode(200)
  markPaid(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.disbursements.decide(id, 'MARK_PAID', admin, null, ip);
  }
}
