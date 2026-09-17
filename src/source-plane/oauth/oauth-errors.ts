/**
 * What the public callback tells the browser when the return leg fails
 * — a sentence, and the admin origin the page may post it to.
 */
export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    readonly origin: string | null = null,
  ) {
    super(message);
  }
}
