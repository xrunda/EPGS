import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 弹层标题栏固定在顶部的回归护栏（issue #133）。
 *
 * 为什么要读 CSS 源码：这五个弹层的滚动容器就是弹层本身
 * （`.xxx-modal { max-height: calc(100dvh - 48px); overflow: auto }`），标题栏是它的
 * 第一个孩子。少一条 `position: sticky` 就会跟着正文一起滚走，滚到一半右上角的 ×
 * 看不见了 —— 但 jsdom 没有布局引擎（vitest 也没开 `css: true`），吸附在单测里测不出来，
 * 所以这里只钉住那几条声明不被删掉、不被挪进 @media，**渲染结果的证据是实测**
 * （1440×900 与 1920×1080 下滚到底部，读标题栏与 × 的实际坐标，见 PR）。
 *
 * 同类做法见 `button-text-wrap.test.ts`（issue #110）与
 * `apps/api/src/security/closed-loop-absence.spec.ts`。
 */

/*
  用 process.cwd() 定位而不是 import.meta.url（同 button-text-wrap.test.ts）：
  vitest 里模块由 Vite 通过 HTTP 提供，`import.meta.url` 是 http 协议；`?raw` 导入也
  不行。vitest 的 cwd 就是包根（apps/web），定位不到会直接 ENOENT 报错，不会变成一条
  静默通过的假绿。
*/
const read = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
    // 先去注释再解析：下面这些规则的说明里会出现 `}`（例如引用 `.rules-modal { … }`），
    // 而 ruleBody 是「从 `{` 找到第一个 `}`」，不去注释就会被注释里的花括号截断。
    .replace(/\/\*[\s\S]*?\*\//g, '');

const escape = (selector: string): string => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 取出 `selector {` 到配对 `}` 之间的声明文本。
 *
 * 正则锚在行首，所以**缩进在 `@media` 里的同名规则匹配不到** —— 这正是要表达的约束：
 * 吸附必须在顶层规则里、对所有宽度生效，而不是只写在某个断点里。
 */
function ruleBody(css: string, selector: string): string | null {
  const match = new RegExp(`^${escape(selector)}\\s*\\{`, 'm').exec(css);
  if (!match) return null;
  const from = match.index + match[0].length;
  const to = css.indexOf('}', from);
  return to === -1 ? null : css.slice(from, to);
}

/** 取某条规则里某个属性的声明值；`background` 不会误配 `background-color`。 */
function declaration(css: string, selector: string, property: string): string | null {
  const body = ruleBody(css, selector);
  if (body === null) return null;
  const match = new RegExp(`(?:^|[;{])\\s*${escape(property)}\\s*:\\s*([^;]+)`).exec(body);
  return match ? match[1].trim() : null;
}

/** 五个「弹层自身即滚动容器」的弹层；.auth-modal 没有 max-height、.drawer 已是 flex 列布局，都不在内。 */
const MODALS = [
  {
    label: 'AI 语义监控',
    css: 'SemanticMonitorModal.css',
    modal: '.semantic-modal',
    header: '.semantic-modal__header',
  },
  {
    label: '关键词监控',
    css: 'RulesModal.css',
    modal: '.rules-modal',
    header: '.rules-modal__header',
  },
  {
    label: '用户管理',
    css: 'UsersModal.css',
    modal: '.users-modal',
    header: '.users-modal__header',
  },
  {
    label: '消息推送配置',
    css: 'NotificationModal.css',
    modal: '.notification-modal',
    header: '.notification-modal__header',
  },
  {
    label: '关注等级分歧',
    css: 'LevelConflictsModal.css',
    modal: '.level-conflict-modal',
    header: '.level-conflict-modal__header',
  },
] as const;

describe('弹层标题栏固定在顶部，不随正文滚走（issue #133）', () => {
  for (const { label, css: file, modal, header } of MODALS) {
    describe(label, () => {
      it('滚动容器确实还是弹层本身（前提变了就该重新判断这条护栏）', () => {
        expect(declaration(read(file), modal, 'overflow')).toBe('auto');
      });

      it(`${header} 吸附在顶部`, () => {
        const body = ruleBody(read(file), header);
        expect(body).not.toBeNull();
        expect(body).toMatch(/position:\s*sticky/);
        expect(body).toMatch(/top:\s*0/);
      });

      it('标题栏背景不透明，且与弹层面板同色（否则正文会从它下面透出来）', () => {
        const panelBackground = declaration(read(file), modal, 'background');
        const headerBackground = declaration(read(file), header, 'background');

        // 弹层自身是半透明玻璃或换了写法时，下面那条比较就没有意义了，先钉住前提。
        expect(panelBackground).toBe('var(--surface-panel)');
        expect(headerBackground).toBe(panelBackground);
      });

      it('层级高于吸附在底部、z-index 为 1 的 .panel-actions--sticky', () => {
        // 只有视口极矮、上下两条吸附条抢同一块地方时才会打架，但那时顺序必须是对的。
        expect(declaration(read(file), header, 'z-index')).toMatch(/^[2-9]\d*$/);
      });
    });
  }
});
