import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 按钮标签折行的回归护栏（issue #110）。
 *
 * 为什么是一个读 CSS 源码的测试：这两个缺陷都是**少了一条 CSS 声明**造成的 ——
 * 中文没有空格，浏览器可以在任意两个字之间断行，所以一个按钮的 min-content 宽度
 * 只有一个字；只要按钮落在一个会收缩的 flex 行里、自身又没有 `white-space: nowrap`，
 * 它就会被压到比标签还窄、文字竖排。jsdom 没有布局引擎（vitest 也没开 `css: true`），
 * 折行在单测里测不出来，所以这里只钉住那条声明不被删掉，**渲染结果的证据是两个
 * 分辨率、六档宽度下的实测**（见 PR #110）。
 *
 * 同类做法见 `apps/api/src/security/closed-loop-absence.spec.ts`：那条绊线同样是
 * 读源码断言、同样是「防止某个东西被悄悄删掉」。
 */

/*
  用 process.cwd() 定位而不是 import.meta.url：vitest 里模块是 Vite 通过 HTTP
  提供的，`import.meta.url` 是 http 协议，fileURLToPath 会抛「The URL must be of
  scheme file」。`?raw` 导入也不行 —— 没开 `test.css`，CSS 模块被替换成空串。
  vitest 的 cwd 就是包根（apps/web），所以相对路径稳定；万一定位不到会直接
  ENOENT 报错，不会变成一条静默通过的假绿。
*/
const read = (name: string): string => readFileSync(resolve(process.cwd(), 'src', name), 'utf8');

const escape = (selector: string): string => selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 取出 `selector {` 到配对 `}` 之间的声明文本。
 *
 * 正则锚在行首（`^`，不加 `i`），所以**缩进在 `@media` 里的同名规则匹配不到** ——
 * 这正是要表达的约束：`flex-wrap: wrap` 必须在顶层规则里，对所有宽度生效，
 * 而不是像 issue #110 修复前那样只写在 `@media (max-width: 900px)` 里。
 */
function ruleBody(css: string, selector: string): string | null {
  const match = new RegExp(`^${escape(selector)}\\s*\\{`, 'm').exec(css);
  if (!match) return null;
  const from = match.index + match[0].length;
  const to = css.indexOf('}', from);
  return to === -1 ? null : css.slice(from, to);
}

describe('按钮标签不许在内部断行（issue #110）', () => {
  it('表格操作列的按钮带 white-space: nowrap', () => {
    const body = ruleBody(read('RulesModal.css'), '.table-actions button');
    expect(body).not.toBeNull();
    expect(body).toMatch(/white-space:\s*nowrap/);
  });

  it('工作台工具栏在顶层规则里就允许换行，不只在窄屏的 @media 里', () => {
    const body = ruleBody(read('Workbench.css'), '.workbench__toolbar');
    // ruleBody 只匹配行首无缩进的规则；匹配不到就说明它被挪进了 @media
    expect(body).not.toBeNull();
    expect(body).toMatch(/flex-wrap:\s*wrap/);
  });

  it('六个操作按钮成组，换行按组发生而不是逐个落行', () => {
    const toolbar = read('Workbench.css');
    expect(ruleBody(toolbar, '.workbench__toolbar-actions')).toMatch(/display:\s*flex/);
    // 组内不换行：否则又退回「某一个按钮被单独挤到第二行」的形态
    expect(ruleBody(toolbar, '.workbench__toolbar-actions')).toMatch(/flex-wrap:\s*nowrap/);
  });
});
