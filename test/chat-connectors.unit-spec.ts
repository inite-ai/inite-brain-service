/**
 * The chat connectors' pure parts (W4.7): Slack's mrkdwn reduced to
 * text (channel and group mentions, links, entities, files named),
 * Telegram's turn (speaker for a person, a channel post and a bot;
 * caption and media named; the edit as the revision) and the dev
 * override that points the Bot API at a fake.
 */
import {
  speakerOf,
  telegramApi,
  turnOf,
  type TgMessage,
} from '../src/source-plane/connectors/telegram.connector';
import { mrkdownToText } from '../src/source-plane/connectors/slack.connector';

const chat = { id: -1001234567890, type: 'supergroup', title: 'Acme Team' } as const;

function message(over: Partial<TgMessage> = {}): TgMessage {
  return {
    message_id: 11,
    chat: { ...chat },
    date: Date.parse('2026-09-15T10:00:00Z') / 1000,
    ...over,
  } as TgMessage;
}

describe('slack: mrkdwn to text', () => {
  it('channel and group mentions, links, mail links and entities', () => {
    expect(
      mrkdownToText(
        'ping <#C123|deploys> and <!subteam^S1|@oncall> — see <https://acme.test/runbook|the runbook>, bare <https://acme.test/x>, mail <mailto:ops@acme.test|ops> <!here> 5 &lt; 6 &amp; ok',
        [],
      ),
    ).toBe(
      'ping #deploys and @oncall — see the runbook (https://acme.test/runbook), bare https://acme.test/x, mail ops@acme.test @here 5 < 6 & ok',
    );
  });

  it('a mention nobody resolved degrades to its name or id, never the markup', () => {
    expect(mrkdownToText('ping <@U123|grace> and <@U456>', [])).toBe('ping @grace and @U456');
  });

  it('files are named after the text, and a file-only message is still a turn', () => {
    expect(mrkdownToText('here it is', [{ name: 'q4-plan.pdf' }])).toBe(
      'here it is\n\n[attachment: q4-plan.pdf]',
    );
    expect(mrkdownToText('', [{ title: 'screenshot.png' }])).toBe('[attachment: screenshot.png]');
  });
});

describe('telegram: a message as one turn', () => {
  it('a person speaks by name, the text and the time are the message’s', () => {
    const t = turnOf(
      message({
        from: { id: 7, first_name: 'Grace', last_name: 'Hopper' },
        text: "I'll take the migration.",
      }),
    );
    expect(t).toEqual({
      text: "I'll take the migration.",
      speaker: 'Grace Hopper',
      at: '2026-09-15T10:00:00.000Z',
      messageId: '11',
    });
  });

  it('a user without a name speaks by @username; a channel post speaks as the channel', () => {
    expect(speakerOf(message({ from: { id: 8, username: 'ada' }, text: 'hi' }))).toBe('@ada');
    expect(
      speakerOf(
        message({
          sender_chat: { id: -100999, type: 'channel', title: 'Acme News' },
          from: { id: 1087968824, first_name: 'Group', is_bot: true },
          text: 'Release 2.3 is out.',
        }),
      ),
    ).toBe('Acme News');
  });

  it('a caption with media, and media alone, are named in the turn', () => {
    expect(
      turnOf(
        message({
          from: { id: 7, first_name: 'Grace' },
          caption: 'the signed page',
          document: { file_name: 'contract.pdf' },
        }),
      ).text,
    ).toBe('the signed page\n\n[attachment: contract.pdf]');
    expect(turnOf(message({ from: { id: 7, first_name: 'Grace' }, voice: {} })).text).toBe(
      '[attachment: voice message]',
    );
    expect(
      turnOf(message({ from: { id: 7, first_name: 'Grace' }, poll: { question: 'Ship Friday?' } }))
        .text,
    ).toBe('[attachment: poll: Ship Friday?]');
  });
});

describe('telegram: the dev override', () => {
  it('unset = api.telegram.org over public egress; set = the fake under the private opt-in', () => {
    expect(telegramApi({})).toEqual({ base: 'https://api.telegram.org', private: false });
    expect(telegramApi({ SOURCE_TELEGRAM_API_BASE: 'http://127.0.0.1:9/' })).toEqual({
      base: 'http://127.0.0.1:9',
      private: true,
    });
  });
});
