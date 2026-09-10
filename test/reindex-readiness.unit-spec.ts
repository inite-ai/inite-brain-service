import { ServiceUnavailableException } from '@nestjs/common';
import { ReindexEmbeddingsService } from '../src/ai/embedder/reindex-embeddings.service';

describe('ReindexEmbeddingsService warmup failure', () => {
  it('propagates an unavailable embedder instead of reporting a successful zero-write run', async () => {
    const unavailable = new ServiceUnavailableException('primary embedder is warming');
    const engine = {
      reindexTenant: jest.fn().mockRejectedValue(unavailable),
      providerId: () => 'bge-m3:Xenova/bge-m3:1024',
    };
    const svc = new ReindexEmbeddingsService(
      { fanOutRoster: () => ['tenant-a', 'tenant-b'] } as any,
      engine as any,
    );
    await expect(svc.run({ allTables: true })).rejects.toBe(unavailable);
    expect(engine.reindexTenant).toHaveBeenCalledTimes(1);
  });
});
