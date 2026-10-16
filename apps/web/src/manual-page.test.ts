import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 医生向使用手册（issue #147）的静态护栏。
 *
 * 这一页是**纯静态资源**：`apps/web/public/manual.html` 由 Vite 原样拷进 `dist/`，
 * nginx 的 `try_files $uri $uri/ /index.html` 先看磁盘因而直接命中。因此它上面
 * 没有任何组件、没有类型、没有运行时 —— 只有下面这几条断言能让它别悄悄坏掉。
 *
 * 为什么要读源码来钉：这一页坏掉的方式**全是静默的**。
 * 链接指错文件名 → nginx 回落到 SPA，返回 200 的一个空应用页，不是 404；
 * 手册里混进一个 CDN 链接 → 网闸后面拉不到，页面看起来"只是样式有点土"；
 * 正文里出现闭环词 → 直接违反 acceptance.md 场景 10 的全站断言。
 * 三种都不会让任何别的测试变红。
 *
 * 与 `native-input-size.test.ts` / `button-text-wrap.test.ts` 同风格：
 * 用 process.cwd() 定位（vitest 的 cwd 就是包根 apps/web），定位不到会直接
 * ENOENT 报错，不会变成一条静默通过的假绿。
 */

const MANUAL_RELATIVE_PATH = 'manual.html';
const manualPath = resolve(process.cwd(), 'public', MANUAL_RELATIVE_PATH);
const appTsx = readFileSync(resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
const manual = readFileSync(manualPath, 'utf8');

/**
 * 入口处的文件名必须与磁盘上的文件名逐字一致。
 * 用一个常量派生两条断言，改文件名时两边一起改，漂移不了。
 */
const MANUAL_URL = `/${MANUAL_RELATIVE_PATH}`;

describe('使用手册入口指向一个真实存在的同源文件（issue #147）', () => {
  it('apps/web/public/manual.html 存在且不是空文件', () => {
    expect(existsSync(manualPath)).toBe(true);
    // 空文件也能通过 existsSync —— 那会是一个 nginx 命中了但什么都没有的页面。
    expect(manual.trim().length).toBeGreaterThan(2000);
  });

  it('App.tsx 的 href 就是那个文件，不是别的路径', () => {
    // 这是本文件最重要的一条。写错文件名不会 404，只会返回一个 200 的空应用壳
    // —— 用户点"使用手册"看到一片空白，而所有测试都是绿的。
    expect(appTsx).toContain(`href="${MANUAL_URL}"`);
  });

  it('入口必须写确切扩展名：不带扩展名会被 SPA 回落吞掉', () => {
    // nginx 的 try_files 最后一项是 /index.html，所以 /manual（无扩展名）会命中
    // 前端路由而不是这一页。钉住这条，免得有人"顺手"把 URL 美化掉。
    expect(MANUAL_URL.endsWith('.html')).toBe(true);
  });

  it('在新标签页打开，且带 noopener', () => {
    // 手册是给"边看边做"用的：同标签跳走会丢掉工作台的筛选与滚动状态；
    // noopener 是 target=_blank 的标准搭配。
    const link = /<a[^>]*className="app-header__help"[^>]*>/.exec(appTsx)?.[0] ?? '';
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener"');
  });
});

describe('手册是自带样式的单文件，适配网闸环境（issue #147）', () => {
  it('不引用任何外部资源 —— 堡垒机在网闸后面，CDN 拉不到', () => {
    // 只允许同源相对路径与页内锚点。
    const offOrigin = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//.exec(manual);
    expect(offOrigin?.[0] ?? null).toBeNull();
    expect(manual).not.toMatch(/@import/);
  });

  it('样式内联在这一页里，不链 tokens.css', () => {
    // tokens.css 打包后是**带哈希的文件名**，静态页链不上；颜色是按值抄的，
    // 所以这里只钉"确实自带了一份 <style>"。
    expect(manual).toContain('<style>');
    expect(manual).not.toMatch(/<link[^>]+stylesheet/);
  });
});

describe('手册正文遵守全站副作用红线（issue #147）', () => {
  /*
    acceptance.md 场景 10：全站不存在上报、知晓、处理、误报、日报等入口或可调用 API。
    该断言的实现是 `apps/api/src/security/closed-loop-absence.spec.ts`，但它的 web 分支
    只递归扫 `apps/web/src` 下的 `.ts/.tsx` —— `public/*.html` **不在扫描范围内**。
    手册是纯文案、又恰好是"最可能顺口承诺一个跟进状态"的地方，所以在这里补上这处缺口。
  */
  const CLOSED_LOOP_UI_LABELS = /待上报|已上报|已知晓|已处理|误报|日报/;

  it('不含闭环词', () => {
    const hit = CLOSED_LOOP_UI_LABELS.exec(manual);
    expect(hit?.[0] ?? null).toBeNull();
  });

  it('不含 /api/ 路径字面量', () => {
    // 手册没有理由提到任何接口路径；出现就说明有人把实现细节抄进了医生文档。
    expect(manual).not.toContain('/api/');
  });

  it('不含 11 位以上连续数字（患者标识）', () => {
    // 仓库是公开的，这一页又会随每个环境一起发布。手册里不该出现住院号/检查号一类
    // 长数字，举例子时也不许带真实姓名。
    const longDigits = /[0-9]{11,}/.exec(manual);
    expect(longDigits?.[0] ?? null).toBeNull();
  });

  it('常驻"仅用于监测，不作为正式诊断"的免责提示', () => {
    // 与 AlertApp / ExportModal / SemanticMonitorModal 同一句口径。手册是唯一
    // 一份可以脱离系统被单独传阅的材料，这句话必须跟着它走。
    expect(manual).toContain('不作为正式诊断');
  });
});
