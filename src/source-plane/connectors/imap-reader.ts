import type { Socket } from 'node:net';
import { ImapError } from './imap-error';

const LINE_MAX = 1024 * 1024;

/** Pull-based reads over a socket's push: lines (CRLF-terminated) and exact byte counts. */
export class SocketReader {
  private buf: Buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(
    socket: Socket,
    private readonly maxBytes: number,
  ) {
    socket.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection closed')));
  }

  async readLine(): Promise<Buffer> {
    for (;;) {
      const at = this.buf.indexOf('\r\n');
      if (at !== -1) {
        const line = this.buf.subarray(0, at);
        this.buf = this.buf.subarray(at + 2);
        return line;
      }
      if (this.buf.length > LINE_MAX) throw new ImapError('imap: line too long', 'protocol');
      await this.more();
    }
  }

  async readBytes(n: number): Promise<Buffer> {
    if (n > this.maxBytes) throw new ImapError('imap: literal larger than the cap', 'protocol');
    while (this.buf.length < n) await this.more();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  private more(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.waiting = () => {
        this.waiting = null;
        if (this.failure) reject(this.failure);
        else resolve();
      };
    });
  }

  private wake(): void {
    this.waiting?.();
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = new ImapError(`imap: ${err.message}`, 'network');
    this.wake();
  }
}
