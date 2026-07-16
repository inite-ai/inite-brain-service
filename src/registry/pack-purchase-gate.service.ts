import {
  BadGatewayException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BillingClientService } from '../billing/billing-client.service';
import {
  BillingRequestError,
  BillingUnavailableError,
} from '../billing/billing-errors';
import { RegistryMetaService } from './registry-meta.service';
import type { PaymentRequiredHint } from '../contracts/registry/marketplace.schema';

/**
 * The paid-pack install gate (docs/domain-packs.md "Marketplace") —
 * sits inside PackRegistryService.resolveForInstall, the single install
 * choke point, BEFORE the download counter.
 *
 * Decision table:
 *   - no meta row / paid=false           → pass (free pack)
 *   - paid but billing integration off   → pass (self-hosted = free:
 *     the meta row may have been hand-copied, but without a billing
 *     service there is nothing to buy)
 *   - paid + active entitlement          → pass
 *   - paid + no entitlement              → 402 with a self-describing
 *     hint (checkout route to call, then retry the install)
 *   - paid + billing unreachable         → 503 (fail-closed: we cannot
 *     verify, so we refuse rather than leak a paid pack)
 *   - paid + billing rejected the lookup → 502
 */
@Injectable()
export class PackPurchaseGateService {
  private readonly logger = new Logger(PackPurchaseGateService.name);

  constructor(
    private readonly meta: RegistryMetaService,
    private readonly billing: BillingClientService,
  ) {}

  async assertInstallable(args: {
    companyId: string;
    packId: string;
  }): Promise<void> {
    const meta = await this.meta.getMeta(args.packId);
    if (!meta?.paid) return;
    if (!this.billing.enabled()) return;
    let entitled: boolean;
    try {
      entitled = await this.billing.hasEntitlement({
        companyId: args.companyId,
        key: `domain_pack:${args.packId}`,
      });
    } catch (e) {
      if (e instanceof BillingUnavailableError) {
        this.logger.warn(
          `Entitlement check for ${args.packId} failed closed: ${e.message}`,
        );
        throw new ServiceUnavailableException(
          `billing service is unavailable — cannot verify the entitlement for paid pack "${args.packId}"; retry shortly`,
        );
      }
      if (e instanceof BillingRequestError) {
        throw new BadGatewayException(
          `billing service rejected the entitlement lookup for pack "${args.packId}" (HTTP ${e.status})`,
        );
      }
      throw e;
    }
    if (entitled) return;
    const hint: PaymentRequiredHint = {
      statusCode: 402,
      error: 'Payment Required',
      message: `pack "${args.packId}" is a paid pack — purchase via the checkout endpoint, then retry`,
      packId: args.packId,
      ...(meta.priceCode ? { priceCode: meta.priceCode } : {}),
      ...(meta.displayPrice ? { displayPrice: meta.displayPrice } : {}),
      checkout: {
        method: 'POST',
        path: `/v1/admin/registry/packs/${encodeURIComponent(args.packId)}/checkout`,
      },
    };
    throw new HttpException(hint, HttpStatus.PAYMENT_REQUIRED);
  }
}
