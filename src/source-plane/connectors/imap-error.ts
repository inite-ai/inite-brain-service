/** What the IMAP client and connector throw: the kind names the operator's next step. */
export class ImapError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'no' | 'protocol' | 'network',
  ) {
    super(message);
  }
}
