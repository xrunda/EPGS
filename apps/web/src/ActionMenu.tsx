import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import './ActionMenu.css';

/** 二级菜单里的一项。 */
export interface ActionMenuItem {
  /** 菜单项文字，同时就是它的无障碍名称。 */
  label: string;
  /** 选中后执行。组件先关菜单，再调用它。 */
  onSelect(): void;
}

interface ActionMenuProps {
  /** 触发按钮的无障碍名称（按钮上只画一个「⋯」，没有可读文字）。 */
  label: string;
  items: ActionMenuItem[];
  /** 菜单面板贴哪一边，默认贴右（用在页面右上角）。 */
  align?: 'start' | 'end';
  /** 触发按钮的外观类：顶栏是深底、工作台工具栏是浅底，外观由调用方给。 */
  triggerClassName?: string;
  className?: string;
}

/**
 * 「⋯」二级菜单（issue #116）。
 *
 * 为什么是一个组件而不是两处各写一遍：两处要的交互**逐条相同**，而且都不平凡 ——
 * Esc 关闭并把焦点还给触发按钮、点外部关闭、`aria-expanded` 跟着变、方向键在项间
 * 移动、点选项后先关菜单再执行。这套逻辑写两遍就是两份迟早各自跑偏的实现。
 *
 * 键盘可达是硬要求、不是加分项：入口收进二级菜单之后，菜单就是**唯一**入口，
 * 键盘走不到等于这个功能对键盘用户直接消失。所以菜单项是真 `<button>`，
 * Tab 能逐个走到（不搞 roving tabindex —— issue #116 的验收标准要的就是
 * 「Tab + Enter + Esc 能触达每一项」）；↑/↓/Home/End 是额外给的，不是替代。
 *
 * 菜单项只在展开时渲染（不是 CSS 隐藏）：隐藏但仍然在 DOM 里的话，Tab 会摸到
 * 一堆看不见的按钮。
 */
export function ActionMenu({
  label,
  items,
  align = 'end',
  triggerClassName,
  className,
}: ActionMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /*
    展开后把焦点送进第一项：键盘用户 Enter 打开之后，下一步按 Tab 才落在菜单里，
    而不是继续往页面后面跑。鼠标用户看不出区别。
  */
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector('button')?.focus();
  }, [open]);

  /*
    点外部关闭。监听 `mousedown` 而不是 `click`：click 要等按下与抬起都完成，
    拖选文字时松手在菜单外也会被当成「点外部」，菜单会莫名其妙消失。
    这里**不**把焦点抢回触发按钮 —— 用户是主动点去别处的，把焦点拽回来会打断他。
    Esc 那条路径才还焦点（见下）。
  */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const closeAndRestoreFocus = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveFocus = (step: number): void => {
    const buttons = [...(menuRef.current?.querySelectorAll('button') ?? [])];
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    // current === -1（焦点不在任何一项上）时从列表尾部进入，按 ↓ 会落到第一项
    const next = (current + step + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  /*
    焦点离开菜单就收起面板。Tab 从最后一项继续往后走时焦点已经离开，面板还浮在
    那儿就是一块没人控制的东西 —— 键盘用户看不到自己跟它还有没有关系。
    焦点只是从一项换到另一项、或 Shift+Tab 回到触发按钮时不算离开（relatedTarget
    仍在容器内），否则菜单会在 Tab 遍历到一半时自己关掉。
    relatedTarget 为 null（焦点落到 body、或整个窗口失焦）按「离开」处理：那时候
    菜单留着也没有意义，点外部那条路径本来也会关。
  */
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!open) return;
    if (rootRef.current?.contains(event.relatedTarget as Node)) return;
    setOpen(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      // 不让它继续冒泡：将来若有外层弹层，Esc 应该只关这一层
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    }
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = menuRef.current?.querySelector('button');
      first?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      const buttons = menuRef.current?.querySelectorAll('button');
      buttons?.[buttons.length - 1]?.focus();
    }
  };

  return (
    <div
      className={`action-menu${className ? ` ${className}` : ''}`}
      ref={rootRef}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        className={`action-menu__trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
        type="button"
        ref={triggerRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {/* 三个点纯装饰，名称由 aria-label 给 */}
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          className={`action-menu__panel action-menu__panel--${align}`}
          id={menuId}
          role="menu"
          aria-label={label}
          ref={menuRef}
        >
          {items.map((item) => (
            <button
              className="action-menu__item"
              type="button"
              role="menuitem"
              key={item.label}
              onClick={() => {
                // 先关菜单再执行：选项打开的弹层要拿到干净的页面状态，
                // 也避免菜单残留在弹层底下
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
