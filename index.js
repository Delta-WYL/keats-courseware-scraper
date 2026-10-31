// Host plugin for the KEATS courseware scraper bundle.
// Registers:
//  1. the `keats_scrape` tool  — the agent calls it automatically when the
//     user says the fixed phrase (爬取KEATS课件 / KEATS课件爬取 etc.);
//  2. the `/keats` slash command — a deterministic fixed command that runs
//     the whole pipeline without going through the model.
import { runScrape } from './scraper.js';

export const name = 'keats-scraper';
export const inject = ['tools', 'commands', 'workingDirectory'];

const DEFAULTS = {
  chromeDebugPort: 9222,
  outputDir: '',
  courses: [],
  downloadSharePoint: true,
  concurrency: 4,
};

const TRIGGER_HINT =
  'Trigger phrases: 爬取KEATS课件 / KEATS课件爬取 / 下载KEATS课件 / 抓取KEATS课件 / scrape KEATS courseware.';

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };

  ctx.tools.register({
    name: 'keats_scrape',
    description:
      'Fully automatic KEATS (KCL Moodle) courseware scraper. Call this tool immediately — ' +
      'without asking which courses or for confirmation — whenever the user says ' +
      '"爬取KEATS课件", "KEATS课件爬取", "下载KEATS课件", "抓取KEATS课件", "KEATS课件", ' +
      'or any request to scrape or download KEATS course files. ' + TRIGGER_HINT + ' ' +
      'It reads the KEATS login session from a locally running Chrome (DevTools port 9222), ' +
      'lists all enrolled courses, downloads every file resource and folder into a brand-new ' +
      'timestamped folder, and returns a summary. Pass `courses` (course IDs) or `courseNames` ' +
      '(name keywords) to restrict the course set, `outputDir` to choose the base directory ' +
      '(default: the session directory; files land in <base>/keats-downloads/<timestamp>/<course>/), ' +
      'and `listOnly: true` to only list enrolled courses without downloading.',
    parameters: {
      type: 'object',
      properties: {
        courses: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Optional KEATS course IDs to scrape. Omit or pass an empty array to scrape all enrolled courses.',
        },
        courseNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional keywords that must all appear in the course name; restricts the course set.',
        },
        outputDir: {
          type: 'string',
          description: 'Optional base directory. A brand-new timestamped folder is created under it.',
        },
        listOnly: {
          type: 'boolean',
          description: 'Only list enrolled courses (id + name) without downloading any files.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['runDir', 'totalCourses', 'totalFiles', 'totalBytes', 'failures', 'externalLinks', 'summary'],
        properties: {
          runDir: { type: 'string', description: 'Absolute path of the new folder that received the files.' },
          totalCourses: { type: 'integer', description: 'Number of courses processed.' },
          totalFiles: { type: 'integer', description: 'Number of files downloaded.' },
          totalBytes: { type: 'integer', description: 'Total bytes downloaded.' },
          failures: { type: 'integer', description: 'Number of failed items.' },
          externalLinks: { type: 'integer', description: 'Number of external (SharePoint/OneDrive etc.) links found.' },
          summary: { type: 'string', description: 'Human-readable summary of the run.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    timeoutMs: 30 * 60 * 1000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('keats_scrape requires an agent Session');
      const baseDir =
        (typeof args.outputDir === 'string' && args.outputDir.trim()) ||
        (typeof cfg.outputDir === 'string' && cfg.outputDir.trim()) ||
        (await ctx.workingDirectory.ensure(exec.agent, exec.signal));
      return runScrape({
        chromeDebugPort: Number(cfg.chromeDebugPort) || 9222,
        baseDir,
        courseIds: Array.isArray(args.courses) ? args.courses.map(Number).filter((n) => Number.isFinite(n)) : [],
        filterKeywords: Array.isArray(args.courseNames) ? args.courseNames.map(String) : [],
        listOnly: args.listOnly === true,
        downloadSharePoint: cfg.downloadSharePoint !== false,
        concurrency: Number(cfg.concurrency) || 4,
        signal: exec.signal,
      });
    },
  });

  ctx.commands.register({
    name: 'keats',
    description: 'KEATS课件爬取：全自动抓取 KEATS 课程文件到新文件夹（可附课程关键词，如 /keats Machine Learning）',
    input: { hint: '课程名关键词，留空抓取全部课程' },
    async handler(invocation) {
      try {
        const baseDir =
          (typeof cfg.outputDir === 'string' && cfg.outputDir.trim()) ||
          (await ctx.workingDirectory.ensure(invocation.agent));
        const keywords = invocation.rawInput.trim();
        const summary = await runScrape({
          chromeDebugPort: Number(cfg.chromeDebugPort) || 9222,
          baseDir,
          courseIds: Array.isArray(cfg.courses) ? cfg.courses.map(Number).filter((n) => Number.isFinite(n)) : [],
          filterKeywords: keywords ? keywords.split(/\s+/) : [],
          listOnly: false,
          downloadSharePoint: cfg.downloadSharePoint !== false,
          concurrency: Number(cfg.concurrency) || 4,
          signal: invocation.signal,
        });
        return { kind: 'success', text: summary.summary };
      } catch (e) {
        return {
          kind: 'error',
          text: `KEATS 课件爬取失败：${e && e.message ? e.message : e}`,
        };
      }
    },
  });
}
