import { IsString, IsIn } from 'class-validator';

export class ForgetEntityDto {
  @IsString()
  @IsIn(['gdpr_request', 'tenant_offboarding', 'operator_request'])
  reason: 'gdpr_request' | 'tenant_offboarding' | 'operator_request';

  @IsString()
  requestId: string;
}
