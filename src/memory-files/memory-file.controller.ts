import { Body, Controller, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard, RequireScopes } from '../auth/api-key.guard';
import { PolicyAction } from '../policy/action-registry';
import { AuthenticatedRequest } from '../auth/api-key.types';
import { MemoryFileService } from './memory-file.service';
import { MemoryFileListDto } from './dto/memory-file-list.dto';
import { MemoryFileReadDto } from './dto/memory-file-read.dto';
import { MemoryFileRenameDto } from './dto/memory-file-rename.dto';
import { MemoryFileWriteDto } from './dto/memory-file-write.dto';

/**
 * File-shaped memory over HTTP — the six operations the Anthropic memory
 * tool performs, minus the two it does client-side.
 *
 * `str_replace` and `insert` are NOT routes. They are read-modify-write
 * on exact text, and doing them here would mean brain owning a merge
 * policy it has no way to get right. The adapter
 * (`@inite/brain-memory-tool`) performs them against the content this
 * surface returns, which keeps the string operations where the tool's
 * semantics define them.
 */
@Controller('v1/memory-files')
@UseGuards(ApiKeyGuard)
export class MemoryFileController {
  constructor(private readonly files: MemoryFileService) {}

  @Post('read')
  @HttpCode(200)
  @RequireScopes('brain:read')
  @PolicyAction('rest.memory_files.read')
  read(@Req() req: AuthenticatedRequest, @Body() body: MemoryFileReadDto) {
    return this.files.read({
      companyId: req.brainAuth.companyId,
      path: body.path,
      userId: body.userId,
    });
  }

  @Post('list')
  @HttpCode(200)
  @RequireScopes('brain:read')
  @PolicyAction('rest.memory_files.read')
  async list(@Req() req: AuthenticatedRequest, @Body() body: MemoryFileListDto) {
    return {
      paths: await this.files.list({
        companyId: req.brainAuth.companyId,
        prefix: body.prefix,
        userId: body.userId,
      }),
    };
  }

  @Put()
  @HttpCode(200)
  @RequireScopes('brain:write')
  @PolicyAction('rest.memory_files.write')
  write(@Req() req: AuthenticatedRequest, @Body() body: MemoryFileWriteDto) {
    return this.files.write({
      companyId: req.brainAuth.companyId,
      path: body.path,
      content: body.content,
      userId: body.userId,
    });
  }

  @Post('rename')
  @HttpCode(200)
  @RequireScopes('brain:write')
  @PolicyAction('rest.memory_files.write')
  rename(@Req() req: AuthenticatedRequest, @Body() body: MemoryFileRenameDto) {
    return this.files.rename({
      companyId: req.brainAuth.companyId,
      path: body.path,
      newPath: body.newPath,
      userId: body.userId,
    });
  }

  @Post('delete')
  @HttpCode(200)
  @RequireScopes('brain:write')
  @PolicyAction('rest.memory_files.write')
  remove(@Req() req: AuthenticatedRequest, @Body() body: MemoryFileReadDto) {
    return this.files.remove({
      companyId: req.brainAuth.companyId,
      path: body.path,
      userId: body.userId,
    });
  }
}
