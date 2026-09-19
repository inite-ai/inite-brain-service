/**
 * The wiki connectors' pure parts (W4.5): Notion blocks and properties
 * reduced to text, Confluence storage format turned into plain HTML for
 * the shared reducer, the v2 API's relative `next` link rooted.
 */
import { htmlToText } from '../src/common/html-text';
import { nextUrl, storageToHtml } from '../src/source-plane/connectors/confluence.connector';
import {
  blockText,
  propertiesText,
  richTextOf,
  titleOf,
} from '../src/source-plane/connectors/notion-text';

describe('notion text', () => {
  it('renders each block type as a markdown-shaped line; unknown types contribute their rich text', () => {
    const rt = (t: string, href?: string) => [{ plain_text: t, ...(href ? { href } : {}) }];
    expect(blockText({ id: '1', type: 'heading_1', heading_1: { rich_text: rt('Title') } })).toBe(
      '# Title',
    );
    expect(blockText({ id: '1', type: 'heading_3', heading_3: { rich_text: rt('Small') } })).toBe(
      '### Small',
    );
    expect(
      blockText({
        id: '1',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: rt('one') },
      }),
    ).toBe('- one');
    expect(
      blockText(
        { id: '1', type: 'numbered_list_item', numbered_list_item: { rich_text: rt('two') } },
        2,
      ),
    ).toBe('2. two');
    expect(
      blockText({ id: '1', type: 'to_do', to_do: { rich_text: rt('done'), checked: true } }),
    ).toBe('[x] done');
    expect(
      blockText({ id: '1', type: 'to_do', to_do: { rich_text: rt('open'), checked: false } }),
    ).toBe('[ ] open');
    expect(blockText({ id: '1', type: 'quote', quote: { rich_text: rt('a\nb') } })).toBe(
      '> a\n> b',
    );
    expect(
      blockText({ id: '1', type: 'code', code: { rich_text: rt('ls'), language: 'shell' } }),
    ).toBe('```shell\nls\n```');
    expect(blockText({ id: '1', type: 'divider', divider: {} })).toBe('---');
    expect(
      blockText({ id: '1', type: 'table_row', table_row: { cells: [rt('a'), rt('b')] } }),
    ).toBe('a | b');
    expect(blockText({ id: '1', type: 'child_page', child_page: { title: 'Sub' } })).toBe(
      '[page] Sub',
    );
    expect(
      blockText({ id: '1', type: 'bookmark', bookmark: { url: 'https://x.test', caption: [] } }),
    ).toBe('https://x.test');
    expect(
      blockText({
        id: '1',
        type: 'bookmark',
        bookmark: { url: 'https://x.test', caption: rt('X') },
      }),
    ).toBe('X (https://x.test)');
    expect(blockText({ id: '1', type: 'image', image: { caption: rt('diagram') } })).toBe(
      '[image] diagram',
    );
    expect(blockText({ id: '1', type: 'image', image: { caption: [] } })).toBe('');
    expect(
      blockText({
        id: '1',
        type: 'paragraph',
        paragraph: { rich_text: rt('see', 'https://x.test/p') },
      }),
    ).toBe('see (https://x.test/p)');
    expect(
      blockText({ id: '1', type: 'some_new_block', some_new_block: { rich_text: rt('text') } }),
    ).toBe('text');
    expect(blockText({ id: '1', type: 'breadcrumb', breadcrumb: {} })).toBe('');
    expect(richTextOf(undefined)).toBe('');
  });

  it('a database row’s properties become key: value lines; the title property is the title', () => {
    const properties = {
      Name: { type: 'title', title: [{ plain_text: 'Ship it' }] },
      Status: { type: 'status', status: { name: 'Done' } },
      Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] },
      Owner: { type: 'people', people: [{ name: 'Ada' }] },
      Due: { type: 'date', date: { start: '2026-10-01', end: '2026-10-03' } },
      Points: { type: 'number', number: 5 },
      Done: { type: 'checkbox', checkbox: true },
      Site: { type: 'url', url: 'https://x.test' },
      Notes: { type: 'rich_text', rich_text: [{ plain_text: 'later' }] },
      Score: { type: 'formula', formula: { type: 'number', number: 0.5 } },
      Ref: { type: 'unique_id', unique_id: { prefix: 'ENG', number: 42 } },
      Links: { type: 'relation', relation: [{ id: 'x' }, { id: 'y' }] },
      Empty: { type: 'select', select: null },
      Files: { type: 'files', files: [{ name: 'spec.pdf' }] },
    };
    expect(titleOf(properties)).toBe('Ship it');
    expect(propertiesText(properties)).toEqual([
      'Status: Done',
      'Tags: a, b',
      'Owner: Ada',
      'Due: 2026-10-01 → 2026-10-03',
      'Points: 5',
      'Done: yes',
      'Site: https://x.test',
      'Notes: later',
      'Score: 0.5',
      'Ref: ENG-42',
      'Links: 2 linked',
      'Files: spec.pdf',
    ]);
    expect(titleOf({})).toBeUndefined();
    expect(propertiesText(null)).toEqual([]);
  });
});

describe('confluence storage', () => {
  it('turns storage format into HTML the shared reducer keeps: code macros from CDATA, page links by title, tasks, no ac: elements', () => {
    const storage =
      '<h2>Deploy</h2><p>Run <strong>this</strong>:</p>' +
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[echo "<hi>" && ls]]></ac:plain-text-body></ac:structured-macro>' +
      '<p>See <ac:link><ri:page ri:content-title="Rollback" /></ac:link> and <ac:emoticon ac:name="tick" />.</p>' +
      '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Pager</ac:task-body></ac:task><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Runbook</ac:task-body></ac:task></ac:task-list>';
    const { body } = htmlToText(storageToHtml(storage));
    expect(body).toContain('Deploy');
    expect(body).toContain('Run this');
    expect(body).toContain('echo "<hi>" && ls');
    expect(body).toContain('See Rollback and');
    expect(body).toContain('[x] Pager');
    expect(body).toContain('[ ] Runbook');
    expect(body).not.toContain('ac:');
    expect(body).not.toContain('CDATA');
    expect(body).not.toContain('language');
  });

  it('roots a site-relative next link at the site’s API origin and leaves an absolute one alone', () => {
    const site = {
      id: 'c1',
      webBase: 'https://acme.atlassian.net/wiki',
      api: 'https://api.atlassian.com/ex/confluence/c1/wiki/api/v2',
    };
    expect(nextUrl(site, '/wiki/api/v2/pages?cursor=abc&limit=250')).toBe(
      'https://api.atlassian.com/ex/confluence/c1/wiki/api/v2/pages?cursor=abc&limit=250',
    );
    expect(nextUrl(site, 'https://api.atlassian.com/x')).toBe('https://api.atlassian.com/x');
  });
});
