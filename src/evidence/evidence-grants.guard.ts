import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { evidenceGrantsApiEnabled, evidenceSubstrateEnabled } from '../common/evidence-flags';

/**
 * Flag gate for the sharing surface as a GUARD, not a handler line — the
 * EvidenceBlobUploadInterceptor lesson applied to a JSON body.
 *
 * Nest runs guards BEFORE parameter pipes, so while the surface is off a
 * malformed POST body answers the bare 404 of an absent route instead of
 * the global ValidationPipe's 400, which would advertise that the route
 * (and the shape of its DTO) exist. Double-gated on the substrate for
 * the same reason the admin dispatch verb is: a dark write seam must not
 * advertise a sharing surface it would 503 anyway.
 *
 * Both flags are read at call time (runtime-mutable) through the common
 * layer — never captured in a constructor.
 */
@Injectable()
export class EvidenceGrantsEnabledGuard implements CanActivate {
  canActivate(): boolean {
    if (!evidenceGrantsApiEnabled() || !evidenceSubstrateEnabled()) throw new NotFoundException();
    return true;
  }
}
