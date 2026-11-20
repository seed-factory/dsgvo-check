import type { RequestRecord } from '../../../../../src/core/snapshot/browser.ts';
import { makeBrowserPlan, makeDom, makeLink } from '../../../../utils/snapshot-builder.ts';
import {
  click,
  defaultPages,
  footerLinks,
  ORIGIN,
  page,
  phase,
  rejectCmp,
  req,
  START,
  site,
} from '../helpers.ts';
import type { Scenario } from './shared.ts';

export const VIDEOS = `${ORIGIN}/videos`;
export const HISTORY = `${ORIGIN}/unternehmen/geschichte`;
export const THUMBNAIL = 'https://i1.ytimg.com/vi/abc123/hqdefault.jpg';

/** Phase A pages: the default ones plus a page that holds the videos. */
export const videoPages = (url = VIDEOS, p = {}) => [...defaultPages('A'), page(url, 'nav', 'A', p)];

/** A request made in the frame `frameId` of a player whose document is `frameUrl`, on the page `pageUrl`. */
export const inPlayer = (
  frameId: string,
  frameUrl: string,
  pageUrl: string = VIDEOS,
): Partial<RequestRecord> => ({ isMainFrame: false, frameId, frameUrl, pageUrl });

export const scenarios: Scenario[] = [
  {
    file: 'violation-youtube-embed.json',
    description:
      'The video page embeds a YouTube player (iframe) that loads its player script without any action',
    expect: { status: 'completed', variants: ['video-loaded'] },
    build: () => {
      const frame = inPlayer('A-f2', 'https://www.youtube.com/embed/abc123');
      return site({
        phases: [
          phase('A', {
            pages: videoPages(),
            requests: [
              req('A-1', 'https://www.youtube.com/embed/abc123', {
                ...frame,
                resourceType: 'document',
                isNavigation: true,
              }),
              req('A-2', 'https://www.youtube.com/s/player/0a1b2c3d/player_ias.vflset/de_DE/base.js', {
                ...frame,
                resourceType: 'script',
              }),
            ],
          }),
        ],
      });
    },
  },
  {
    file: 'violation-thumbnail-after-reject.json',
    description:
      'The history page shows a YouTube thumbnail before any interaction and again as a control page after the reject, which the CMP state confirms',
    expect: { status: 'completed', variants: ['video-loaded'] },
    build: () => {
      const thumbnail = (id: string, p: Partial<RequestRecord> = {}) =>
        req(id, THUMBNAIL, { pageUrl: HISTORY, resourceType: 'image', ...p });
      return site({
        phases: [
          phase('A', { pages: videoPages(HISTORY), requests: [thumbnail('A-1')] }),
          phase('B', {
            click: click('reject'),
            reloaded: true,
            pages: [
              page(START, 'start', 'B'),
              page(START, 'start', 'B', { reload: true }),
              page(HISTORY, 'nav', 'B'),
            ],
            requests: [thumbnail('B-1', { phase: 'B', afterClick: true })],
          }),
        ],
        cmp: rejectCmp({ confirmed: true, pages: { [HISTORY]: 'in-effect' } }),
      });
    },
  },
  {
    file: 'clean-local-preview.json',
    description:
      'The video page shows a placeholder "Video laden" with a preview image from the site itself and only links to the channel',
    expect: { status: 'completed', variants: [] },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: videoPages(VIDEOS, {
              dom: makeDom({
                links: [
                  ...footerLinks(),
                  makeLink({
                    text: 'Unser Kanal',
                    href: 'https://www.youtube.com/@example-channel',
                    region: 'footer',
                  }),
                ],
                embedPlaceholders: [{ kind: 'video', text: 'Video laden' }],
              }),
            }),
            requests: [req('A-1', `${ORIGIN}/media/preview.jpg`, { pageUrl: VIDEOS, resourceType: 'image' })],
          }),
        ],
      }),
  },
  {
    file: 'inconclusive-video-page-blocked.json',
    description:
      'The page chosen for its "Mediathek" link (keyword group video) was behind a challenge and could not be evaluated; no video request elsewhere',
    expect: { status: 'inconclusive', variants: [], reason: 'video-page-not-evaluable' },
    build: () =>
      site({
        phases: [
          phase('A', {
            pages: videoPages(VIDEOS, {
              evaluable: false,
              notEvaluableReason: 'challenge',
              challenge: { detected: true, kind: 'cloudflare', signals: ['title:Just a moment'] },
            }),
          }),
        ],
        plan: makeBrowserPlan({
          pages: [
            { url: START, role: 'start', order: 0, reasons: ['start'], source: 'start' },
            {
              url: VIDEOS,
              role: 'nav',
              order: 4,
              reasons: ['keyword:mediathek'],
              source: 'link',
              keywordGroup: 'video',
            },
          ],
        }),
      }),
  },
];
