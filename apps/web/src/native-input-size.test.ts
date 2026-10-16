import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 原生 radio 必须钉死尺寸的回归护栏（issue #141）。
 *
 * 为什么是一个读 CSS 源码的测试：这个缺陷是**少了一条 CSS 声明**造成的 ——
 * `RulesModal.css` 里有一组裸元素选择器：
 *
 *   input, select, textarea { width: 100%; border: 1px solid …; outline: none }
 *   input, select           { height: 38px; padding: 0 11px }
 *   input:focus, …          { border-color: …; box-shadow: var(--shadow-focus) }
 *
 * Vite 把全仓 CSS 打进同一张样式表，组件级 CSS 文件**不构成作用域**，所以这几条会
 * 泄漏到页面上每一个 `input`。落到一个没钉尺寸的 `<input type="radio">` 上就是：
 * 圆点被撑成 47.5×38 的框，聚焦时 3px 焦点环套在那个框上，看起来是一个大灰方块。
 *
 * jsdom 没有布局引擎（vitest 也没开 `css: true`），「被撑开」在单测里测不出来，所以
 * 这里只钉住那几条声明不被删掉，**渲染结果的证据是实测**（浏览器里读计算样式得到
 * 16×16、`accent-color` 为品牌青，加 2 倍缩放截图，见 PR #141）。
 *
 * 同类做法见 `modal-header-sticky.test.ts`（issue #133）与 `button-text-wrap.test.ts`
 * （issue #110）—— 都是「读源码、防止某条声明被悄悄删掉」。
 */

/*
  用 process.cwd() 定位而不是 import.meta.url（同 button-text-wrap.test.ts）：
  vitest 里模块由 Vite 通过 HTTP 提供，`import.meta.url` 是 http 协议；`?raw` 导入也
  不行（没开 `test.css`）。vitest 的 cwd 就是包根（apps/web），定位不到会直接 ENOENT
  报错，不会变成一条静默通过的假绿。
*/
const read = (name: string): string =>
  readFileSync(resolve(process.cwd(), 'src', name), 'utf8')
    // 先去注释再解析：下面这些规则的说明里会出现 `}` 与 `input`，不去注释会被注释里的
    // 花括号截断，也可能让下面那条「泄漏源仍在」的断言误判。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 把跨行的选择器组收成一行：`input,\nselect {` 是 RulesModal.css 里的实际写法，
    // 不收就匹配不到（ruleBody 是「从行首的选择器找到 {」）。
    .replace(/,\s*\n\s*/g, ', ');

const escape = (selector: string): string => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取出 `selector {` 到配对 `}` 之间的声明文本。缩进在 @media 里的同名规则匹配不到。 */
function ruleBody(css: string, selector: string): string | null {
  const match = new RegExp(`^${escape(selector)}\\s*\\{`, 'm').exec(css);
  if (!match) return null;
  const from = match.index + match[0].length;
  const to = css.indexOf('}', from);
  return to === -1 ? null : css.slice(from, to);
}

/** 取某条规则里某个属性的声明值；`width` 不会误配 `min-width`（正则要求前面是 `;` 或 `{`）。 */
function declaration(css: string, selector: string, property: string): string | null {
  const body = ruleBody(css, selector);
  if (body === null) return null;
  const match = new RegExp(`(?:^|[;{])\\s*${escape(property)}\\s*:\\s*([^;]+)`).exec(body);
  return match ? match[1].trim() : null;
}

/**
 * 全仓所有 `type="radio"` 的宿主 CSS 规则。
 *
 * 目前只有两处 radio；任何一处漏掉尺寸钉死，就会在浏览器里被 RulesModal.css 那条泄漏
 * 撑成大方框 —— 所以这张表必须覆盖「全部」radio，新增第三处时要一起加进来。
 */
const RADIOS = [
  {
    label: '数据导出 · 关注等级',
    css: 'ExportModal.css',
    selector: '.export-level input',
    ownedBy: 'issue #141（本护栏就是为它建的）',
  },
  {
    label: 'AI 语义监控 · 关注等级',
    css: 'SemanticMonitorModal.css',
    selector: '.semantic-level-picker__option input',
    ownedBy: 'issue #88 —— 它一直是钉着的，是正确写法的参照',
  },
] as const;

describe('原生 radio 钉死了尺寸，不被泄漏的全局 input 规则撑开（issue #141）', () => {
  for (const { label, css: file, selector, ownedBy } of RADIOS) {
    describe(`${label}（${ownedBy}）`, () => {
      it('宽高都是 16px：`width: 100%; height: 38px` 会泄漏进来，不钉就会被撑开', () => {
        const css = read(file);
        expect(declaration(css, selector, 'width')).toBe('16px');
        expect(declaration(css, selector, 'height')).toBe('16px');
      });

      it('圆点是品牌青，不是 Chrome 默认蓝', () => {
        const css = read(file);
        expect(declaration(css, selector, 'accent-color')).toBe('var(--teal-700)');
      });
    });
  }

  it('导出弹层把泄漏来的 `padding: 0 11px` 也归了零（border-box 下它会挤掉那 16px）', () => {
    // 只有导出弹层显式归零：全仓另一处 radio（语义监控）没写 padding，靠 border-box
    // 把 11px 夹掉也能得到 16px 的框 —— 两种都成立，所以不断言「都必须写」，
    // 只钉住导出这条写了，别被当成冗余删掉。
    expect(declaration(read('ExportModal.css'), '.export-level input', 'padding')).toBe('0');
  });

  it('泄漏源仍在：RulesModal.css 那组裸元素选择器一旦被改掉，这条护栏的前提就变了', () => {
    // 这条不是「希望泄漏存在」，而是把**前提**钉住：RulesModal.css 一旦把裸选择器收进
    // `.rules-modal` 作用域（根治方案，见 issue #141 的非目标），这两处钉死就不再必需；
    // 那时应当主动重判本文件，而不是让它继续假装在防一个已经不存在的泄漏。
    const css = read('RulesModal.css');
    expect(ruleBody(css, 'input, select')).toMatch(/height:\s*38px/);
    expect(ruleBody(css, 'input:focus, select:focus, textarea:focus')).toContain('--shadow-focus');
  });
});
